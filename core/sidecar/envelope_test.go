package sidecar

import (
	"encoding/json"

	controlwire "github.com/soksak/soksak-contract-control"
)

// Building a request and reading an answer, for the tests in this package.
//
// Arguments are encoded here rather than at each call, so a shape mismatch fails at this line and
// not as a refusal a test has to interpret.

func request(id, command string, args map[string]any) controlwire.Request {
	encoded := make(map[string]json.RawMessage, len(args))
	for name, value := range args {
		raw, err := json.Marshal(value)
		if err != nil {
			panic(err)
		}
		encoded[name] = raw
	}
	return controlwire.Request{ID: id, Command: command, Args: encoded}
}

// answerData reads a result out of the shape a generic caller parses every answer as.
func answerData(response controlwire.Response, target any) error {
	raw, err := json.Marshal(response.Result)
	if err != nil {
		return err
	}
	var answer struct {
		Code string          `json:"code"`
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(raw, &answer); err != nil {
		return err
	}
	return json.Unmarshal(answer.Data, target)
}
