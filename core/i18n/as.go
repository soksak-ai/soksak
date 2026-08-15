package i18n

import "errors"

// as is errors.As, named here so this package's one dependency on the standard
// library's error tree is in one place.
func as(err error, target **Error) bool { return errors.As(err, target) }
