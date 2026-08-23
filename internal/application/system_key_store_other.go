//go:build !darwin

package application

import keyring "github.com/zalando/go-keyring"

func setSystemKey(service, account, value string) error {
	return keyring.Set(service, account, value)
}
