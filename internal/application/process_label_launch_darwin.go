//go:build darwin && cgo

package application

/*
#include <libproc.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static char *soksak_process_name = NULL;

static int soksak_apply_process_name(const char *name) {
	char *next = strdup(name);
	if (next == NULL) return 0;
	setprogname(next);
	free(soksak_process_name);
	soksak_process_name = next;
	return 1;
}
*/
import "C"

import (
	"strconv"
	"unsafe"

	"github.com/soksak-ai/soksak-core/core/i18n"
)

func launchProcessLabel(value string) (string, error) {
	label, err := processLabelFromEnvironment(value)
	if err != nil {
		return "", err
	}
	if len(label) == 0 || len(label) > 31 {
		return "", i18n.Errorf("application.processLabel.darwinLength", map[string]string{"bytes": strconv.Itoa(len(label))})
	}
	name := C.CString(label)
	defer C.free(unsafe.Pointer(name))
	if C.soksak_apply_process_name(name) == 0 {
		return "", i18n.Errorf("application.processLabel.retainFailed", nil)
	}
	actual, err := currentDarwinProcessName(int(C.getpid()))
	if err != nil {
		return "", err
	}
	if actual != label {
		return "", i18n.Errorf("application.processLabel.mismatch", map[string]string{"actual": actual, "requested": label})
	}
	return label, nil
}

func currentDarwinProcessName(pid int) (string, error) {
	buffer := make([]byte, 1024)
	count := C.proc_name(C.int(pid), unsafe.Pointer(&buffer[0]), C.uint32_t(len(buffer)))
	if count <= 0 {
		return "", i18n.Errorf("application.processLabel.readFailed", map[string]string{
			"pid": strconv.Itoa(pid), "result": strconv.Itoa(int(count)),
		})
	}
	return string(buffer[:count]), nil
}
