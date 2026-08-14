package main

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"

	"github.com/creack/pty"
	"github.com/wailsapp/wails/v3/pkg/application"
)

type TerminalHandle struct {
	ID         string `json:"id"`
	Generation uint64 `json:"generation"`
}

type TerminalOutput struct {
	ID         string `json:"id"`
	Generation uint64 `json:"generation"`
	Data       string `json:"data"`
}

type terminalSession struct {
	generation uint64
	pty        *os.File
	cmd        *exec.Cmd
}

type TerminalService struct {
	app            *application.App
	mu             sync.Mutex
	nextGeneration uint64
	sessions       map[string]*terminalSession
}

func newTerminalService(app *application.App) *TerminalService {
	return &TerminalService{app: app, sessions: make(map[string]*terminalSession)}
}

func closeTerminalSession(session *terminalSession) {
	if session == nil {
		return
	}
	if session.cmd != nil && session.cmd.Process != nil {
		terminateTerminalProcessGroup(session.cmd.Process.Pid)
	}
	if session.pty != nil {
		_ = session.pty.Close()
	}
	if session.cmd != nil && session.cmd.Process != nil {
		_ = session.cmd.Wait()
	}
}

// install atomically replaces the logical terminal owner with a fresh
// generation. A close or read completion from an older generation can never
// remove the replacement.
func (service *TerminalService) install(id string, session *terminalSession) TerminalHandle {
	service.mu.Lock()
	service.nextGeneration++
	generation := service.nextGeneration
	previous := service.sessions[id]
	session.generation = generation
	service.sessions[id] = session
	service.mu.Unlock()

	closeTerminalSession(previous)
	return TerminalHandle{ID: id, Generation: generation}
}

func (service *TerminalService) release(id string, generation uint64) *terminalSession {
	service.mu.Lock()
	defer service.mu.Unlock()
	session := service.sessions[id]
	if session == nil || session.generation != generation {
		return nil
	}
	delete(service.sessions, id)
	return session
}

func (service *TerminalService) Open(id string, cols, rows uint16) (TerminalHandle, error) {
	if id == "" {
		return TerminalHandle{}, fmt.Errorf("terminal id is required")
	}
	if cols == 0 || rows == 0 {
		return TerminalHandle{}, fmt.Errorf("terminal size must be non-zero")
	}

	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/zsh"
	}
	cmd := exec.Command(shell, "-l")
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")
	file, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: cols, Rows: rows})
	if err != nil {
		return TerminalHandle{}, fmt.Errorf("open terminal %s: %w", id, err)
	}

	handle := service.install(id, &terminalSession{pty: file, cmd: cmd})
	go service.read(handle, file)
	return handle, nil
}

func (service *TerminalService) read(handle TerminalHandle, file *os.File) {
	buffer := make([]byte, 32*1024)
	for {
		count, err := file.Read(buffer)
		if count > 0 && service.app != nil {
			service.app.Event.Emit("terminal:output", TerminalOutput{
				ID: handle.ID, Generation: handle.Generation, Data: string(buffer[:count]),
			})
		}
		if err != nil {
			if err != io.EOF && service.app != nil {
				service.app.Event.Emit("terminal:output", TerminalOutput{
					ID: handle.ID, Generation: handle.Generation, Data: "\r\n[terminal closed]\r\n",
				})
			}
			closeTerminalSession(service.release(handle.ID, handle.Generation))
			return
		}
	}
}

func (service *TerminalService) session(id string, generation uint64) (*terminalSession, error) {
	service.mu.Lock()
	defer service.mu.Unlock()
	session := service.sessions[id]
	if session == nil || session.pty == nil || session.generation != generation {
		return nil, fmt.Errorf("terminal session does not exist: %s/%d", id, generation)
	}
	return session, nil
}

func (service *TerminalService) Write(id string, generation uint64, data string) error {
	session, err := service.session(id, generation)
	if err != nil {
		return err
	}
	_, err = session.pty.WriteString(data)
	return err
}

func (service *TerminalService) Resize(id string, generation uint64, cols, rows uint16) error {
	session, err := service.session(id, generation)
	if err != nil {
		return err
	}
	if cols == 0 || rows == 0 {
		return fmt.Errorf("terminal size must be non-zero")
	}
	return pty.Setsize(session.pty, &pty.Winsize{Cols: cols, Rows: rows})
}

func (service *TerminalService) Close(id string, generation uint64) error {
	closeTerminalSession(service.release(id, generation))
	return nil
}
