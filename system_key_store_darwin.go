//go:build darwin

package main

import (
	"context"
	"os/exec"
	"strings"
	"time"

	"github.com/soksak-ai/soksak-core/core/i18n"
)

const keychainWriteTimeout = 10 * time.Second

func setSystemKey(service, account, value string) error {
	input, err := keychainPasswordInput(service, account, value)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), keychainWriteTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "/usr/bin/security",
		"add-generic-password", "-U", "-s", service, "-a", account, "-w")
	cmd.Stdin = strings.NewReader(input)
	output, runErr := cmd.CombinedOutput()
	if ctx.Err() != nil {
		return i18n.Errorf("systemKeyStore.writeTimeout", map[string]string{"timeout": keychainWriteTimeout.String()})
	}
	if runErr != nil {
		return i18n.Wrap(runErr, "systemKeyStore.writeFailed", map[string]string{"reason": strings.TrimSpace(string(output))})
	}
	return nil
}

func keychainPasswordInput(service, account, value string) (string, error) {
	for name, item := range map[string]string{"service": service, "account": account, "value": value} {
		if item == "" || strings.ContainsAny(item, "\x00\r\n") {
			return "", i18n.Errorf("systemKeyStore.invalidField", map[string]string{"field": name})
		}
	}
	return value + "\n" + value + "\n", nil
}
