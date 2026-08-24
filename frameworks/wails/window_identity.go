package wails

import "net/url"

func windowIdentityURL(raw string, identity string) string {
	parsed, err := url.Parse(raw)
	if err != nil {
		panic("wails: window URL is invalid")
	}
	query := parsed.Query()
	query.Set("identity", identity)
	parsed.RawQuery = query.Encode()
	return parsed.String()
}
