package install

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"

	"github.com/soksak-ai/soksak-core/core/i18n"
)

const maxArtifactDownloadBytes = archiveMaxTotalBytes + 1

type HTTPFetcher struct{ Client *http.Client }

func (fetcher HTTPFetcher) Fetch(ctx context.Context, url string, progress func(uint64)) ([]byte, error) {
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
	var body bytes.Buffer
	buffer := make([]byte, 256<<10)
	var received uint64
	var reported uint64
	if progress != nil {
		progress(0)
	}
	for {
		read, readErr := response.Body.Read(buffer)
		if read > 0 {
			received += uint64(read)
			if received >= maxArtifactDownloadBytes {
				return nil, i18n.Errorf("install.fetch.sizeLimit", nil)
			}
			_, _ = body.Write(buffer[:read])
			if progress != nil && received-reported >= 128<<10 {
				progress(received)
				reported = received
			}
		}
		if readErr != nil {
			if !errors.Is(readErr, io.EOF) {
				return nil, readErr
			}
			break
		}
	}
	if progress != nil && received != reported {
		progress(received)
	}
	return body.Bytes(), nil
}
