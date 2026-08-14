package net

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGetReturnsStatusHeadersAndBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Echo", r.Method)
		w.WriteHeader(201)
		_, _ = w.Write([]byte("hello"))
	}))
	defer server.Close()

	got, err := Do(t.Context(), Request{Method: "GET", URL: server.URL})
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	if got.Status != 201 {
		t.Errorf("status = %d", got.Status)
	}
	if got.Body != "hello" {
		t.Errorf("body = %q", got.Body)
	}
	if got.Headers["X-Echo"] != "GET" {
		t.Errorf("headers = %v", got.Headers)
	}
}

func TestQueryAndHeadersReachTheServer(t *testing.T) {
	var seenQuery, seenHeader string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenQuery = r.URL.Query().Get("q")
		seenHeader = r.Header.Get("X-Token")
	}))
	defer server.Close()

	if _, err := Do(t.Context(), Request{
		Method:  "GET",
		URL:     server.URL,
		Query:   map[string]string{"q": "news & views"},
		Headers: map[string]string{"X-Token": "abc"},
	}); err != nil {
		t.Fatalf("request: %v", err)
	}
	if seenQuery != "news & views" {
		t.Errorf("query = %q", seenQuery)
	}
	if seenHeader != "abc" {
		t.Errorf("header = %q", seenHeader)
	}
}

func TestBodyAndContentTypeAreSent(t *testing.T) {
	var seenBody, seenType string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received, _ := io.ReadAll(r.Body)
		seenBody = string(received)
		seenType = r.Header.Get("Content-Type")
	}))
	defer server.Close()

	if _, err := Do(t.Context(), Request{
		Method:      "POST",
		URL:         server.URL,
		Body:        `{"a":1}`,
		ContentType: "application/json",
	}); err != nil {
		t.Fatalf("request: %v", err)
	}
	if seenBody != `{"a":1}` || seenType != "application/json" {
		t.Errorf("body = %q, content type = %q", seenBody, seenType)
	}
}

func TestAnErrorStatusIsAnAnswerNotAFailure(t *testing.T) {
	// A 500 is what the server said. Turning it into an error would make the
	// caller unable to read the body that explains it.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(500)
		_, _ = w.Write([]byte("boom"))
	}))
	defer server.Close()

	got, err := Do(t.Context(), Request{Method: "GET", URL: server.URL})
	if err != nil {
		t.Fatalf("a 500 must not be an error: %v", err)
	}
	if got.Status != 500 || got.Body != "boom" {
		t.Errorf("response = %+v", got)
	}
}

func TestOnlyHTTPSchemesAreAllowed(t *testing.T) {
	// A plugin passes this URL. Without a scheme check it could read local
	// files through the network capability it was granted for the network.
	for _, url := range []string{"file:///etc/passwd", "ftp://host/x", "", "not a url"} {
		if _, err := Do(t.Context(), Request{Method: "GET", URL: url}); err == nil {
			t.Errorf("scheme was accepted: %q", url)
		}
	}
}

func TestSecretSubstitutionIsRefusedByName(t *testing.T) {
	// Substitution reads the vault, and no vault is open. Sending the request
	// with the placeholder left in would leak the placeholder and look like a
	// server-side authentication failure.
	_, err := Do(t.Context(), Request{
		Method:      "GET",
		URL:         "https://example.com",
		SecretSubst: map[string]string{"token": "secret.api"},
	})
	if err == nil || !strings.Contains(err.Error(), "secret") {
		t.Fatalf("error = %v, want a named refusal", err)
	}
}
