package application

import "testing"

func TestProcessLabelEnvironmentIsExplicitAndValidated(t *testing.T) {
	tests := []struct {
		value string
		want  string
		ok    bool
	}{
		{value: "", want: "soksak", ok: true},
		{value: "soksakv3", want: "soksakv3", ok: true},
		{value: "manual-v3_2.1", want: "manual-v3_2.1", ok: true},
		{value: " leading", ok: false},
		{value: "slash/name", ok: false},
	}
	for _, test := range tests {
		got, err := processLabelFromEnvironment(test.value)
		if test.ok && (err != nil || got != test.want) {
			t.Errorf("process label %q = %q, %v; want %q", test.value, got, err, test.want)
		}
		if !test.ok && err == nil {
			t.Errorf("invalid process label %q was accepted as %q", test.value, got)
		}
	}
}
