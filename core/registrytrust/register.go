package registrytrust

import (
	"bytes"
	"encoding/json"
	"io"
	"time"

	registry "github.com/soksak-ai/soksak-contract-registry"
	"github.com/soksak-ai/soksak-core/core/control"
	"github.com/soksak-ai/soksak-core/core/i18n"
)

func Register(commands *control.Registry, now func() time.Time) {
	commands.MustRegister(control.Command{Name: "registry_certify", Handler: func(args control.Args) (any, error) {
		raw, err := control.RawArg(args, "document")
		if err != nil {
			return nil, err
		}
		var document registry.SignedRegistry
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&document); err != nil {
			return nil, err
		}
		if err := decoder.Decode(&struct{}{}); err != io.EOF {
			return nil, i18n.Errorf("registrytrust.trailingData", nil)
		}
		trust, err := control.Arg[Trust](args, "trust")
		if err != nil {
			return nil, err
		}
		highWater, err := control.OptionalArg[*HighWater](args, "highWater", nil)
		if err != nil {
			return nil, err
		}
		return Verify(document, trust, now(), highWater)
	}})
}
