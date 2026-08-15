// Package net is the bytes that leave this process.
//
// It opens no window and holds no framework, so it is in the core: an HTTP
// request answers the same whether a window asked or a daemon did.
package net

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Request is what a caller asked for.
type Request struct {
	Method      string            `json:"method"`
	URL         string            `json:"url"`
	Headers     map[string]string `json:"headers"`
	Query       map[string]string `json:"query"`
	Body        string            `json:"body"`
	ContentType string            `json:"contentType"`
	// Namespace is the plugin asking. Secrets are per namespace, so this is
	// what keeps one plugin's substitution out of another's vault.
	Namespace string `json:"ns"`
	// SecretSubst names placeholders to fill from the vault before sending.
	SecretSubst map[string]string `json:"secretSubst"`
	Impersonate string            `json:"impersonate"`
}

// Response is what the server said. An error status is part of the answer.
type Response struct {
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"`
}

const requestTimeout = 30 * time.Second

// Do performs one request.
//
// A non-2xx status is an answer, not a failure: turning it into an error would
// leave the caller unable to read the body explaining it.
func Do(ctx context.Context, request Request) (Response, error) {
	if len(request.SecretSubst) > 0 {
		// Substitution reads the vault, and there is no vault yet. Sending the
		// request with placeholders intact would leak the placeholder and read
		// as a server-side authentication failure.
		return Response{}, fmt.Errorf("net: secret substitution is not served yet; no vault is open")
	}
	if request.Impersonate != "" && request.Impersonate != "off" {
		return Response{}, fmt.Errorf("net: impersonation %q is not served yet", request.Impersonate)
	}

	parsed, err := url.Parse(request.URL)
	if err != nil {
		return Response{}, fmt.Errorf("net: %q is not a URL: %w", request.URL, err)
	}
	// A plugin supplies this URL. Without a scheme check, a capability granted
	// for the network would also read local files.
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return Response{}, fmt.Errorf("net: scheme %q is not allowed; only http and https", parsed.Scheme)
	}
	if parsed.Host == "" {
		return Response{}, fmt.Errorf("net: %q has no host", request.URL)
	}

	if len(request.Query) > 0 {
		query := parsed.Query()
		for name, value := range request.Query {
			query.Set(name, value)
		}
		parsed.RawQuery = query.Encode()
	}

	method := request.Method
	if method == "" {
		method = http.MethodGet
	}

	ctx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()

	var body io.Reader
	if request.Body != "" {
		body = strings.NewReader(request.Body)
	}
	outgoing, err := http.NewRequestWithContext(ctx, method, parsed.String(), body)
	if err != nil {
		return Response{}, fmt.Errorf("net: could not build the request: %w", err)
	}
	for name, value := range request.Headers {
		outgoing.Header.Set(name, value)
	}
	if request.ContentType != "" {
		outgoing.Header.Set("Content-Type", request.ContentType)
	}

	incoming, err := http.DefaultClient.Do(outgoing)
	if err != nil {
		return Response{}, fmt.Errorf("net: %s %s: %w", method, parsed.Host, err)
	}
	defer func() { _ = incoming.Body.Close() }()

	received, err := io.ReadAll(incoming.Body)
	if err != nil {
		return Response{}, fmt.Errorf("net: reading the response: %w", err)
	}

	headers := make(map[string]string, len(incoming.Header))
	for name := range incoming.Header {
		headers[name] = incoming.Header.Get(name)
	}
	return Response{Status: incoming.StatusCode, Headers: headers, Body: string(received)}, nil
}
