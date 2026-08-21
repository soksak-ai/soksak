package install

import (
	"context"
	"fmt"
	"io"
	"net/http"

	"github.com/soksak/soksak-core/core/i18n"
)

const maxArtifactDownloadBytes = archiveMaxTotalBytes + 1

type HTTPFetcher struct{ Client *http.Client }

func (fetcher HTTPFetcher) Fetch(ctx context.Context, url string) ([]byte, error) {
	if fetcher.Client == nil {
		return nil, i18n.Errorf("install.fetch.noClient", nil)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	response, err := fetcher.Client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return nil, i18n.Errorf("install.fetch.httpStatus", map[string]string{"status": fmt.Sprint(response.StatusCode)})
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxArtifactDownloadBytes))
	if err != nil {
		return nil, err
	}
	if len(body) >= maxArtifactDownloadBytes {
		return nil, i18n.Errorf("install.fetch.sizeLimit", nil)
	}
	return body, nil
}
