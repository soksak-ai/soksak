package nativebrowser

import (
	"fmt"
	"math"
	"sort"
	"sync"
	"unsafe"
)

type Frame struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

func (frame Frame) Validate() error {
	values := []float64{frame.X, frame.Y, frame.Width, frame.Height}
	for _, value := range values {
		if math.IsNaN(value) || math.IsInf(value, 0) {
			return fmt.Errorf("browser frame must be finite: %+v", frame)
		}
	}
	if frame.Width <= 0 || frame.Height <= 0 {
		return fmt.Errorf("browser frame must be non-empty: %+v", frame)
	}
	return nil
}

type Handle struct {
	ID         string `json:"id"`
	Generation uint64 `json:"generation"`
}

type Receipt struct {
	Handle    Handle `json:"handle"`
	Sequence  uint64 `json:"sequence"`
	Accepted  bool   `json:"accepted"`
	Requested Frame  `json:"requested"`
	Applied   Frame  `json:"applied"`
}

type SurfaceStatus = Receipt

type browserSession struct {
	generation uint64
	native     unsafe.Pointer
	sequence   uint64
	requested  Frame
	applied    Frame
}

type Service struct {
	mu             sync.Mutex
	window         func() unsafe.Pointer
	nextGeneration uint64
	sessions       map[string]*browserSession
}

func NewService(window func() unsafe.Pointer) *Service {
	return &Service{window: window, sessions: make(map[string]*browserSession)}
}

func (service *Service) install(id string, native unsafe.Pointer) Handle {
	service.mu.Lock()
	service.nextGeneration++
	generation := service.nextGeneration
	previous := service.sessions[id]
	service.sessions[id] = &browserSession{generation: generation, native: native}
	service.mu.Unlock()
	if previous != nil && previous.native != nil {
		destroyNativeBrowser(previous.native)
	}
	return Handle{ID: id, Generation: generation}
}

func (service *Service) remove(id string, generation uint64) bool {
	service.mu.Lock()
	session := service.sessions[id]
	if session == nil || session.generation != generation {
		service.mu.Unlock()
		return false
	}
	delete(service.sessions, id)
	service.mu.Unlock()
	if session.native != nil {
		destroyNativeBrowser(session.native)
	}
	return true
}

func (service *Service) current(handle Handle) (*browserSession, error) {
	service.mu.Lock()
	defer service.mu.Unlock()
	session := service.sessions[handle.ID]
	if session == nil || session.generation != handle.Generation || session.native == nil {
		return nil, fmt.Errorf("native browser does not exist: %s/%d", handle.ID, handle.Generation)
	}
	return session, nil
}

func (service *Service) recordFrame(handle Handle, sequence uint64, frame Frame) bool {
	service.mu.Lock()
	defer service.mu.Unlock()
	session := service.sessions[handle.ID]
	if session == nil || session.generation != handle.Generation || sequence <= session.sequence {
		return false
	}
	session.sequence = sequence
	session.requested = frame
	session.applied = frame
	return true
}

func (service *Service) Status() []SurfaceStatus {
	service.mu.Lock()
	defer service.mu.Unlock()
	result := make([]SurfaceStatus, 0, len(service.sessions))
	for id, session := range service.sessions {
		result = append(result, SurfaceStatus{
			Handle: Handle{ID: id, Generation: session.generation}, Sequence: session.sequence,
			Accepted: true, Requested: session.requested, Applied: session.applied,
		})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Handle.ID < result[j].Handle.ID })
	return result
}

func (service *Service) Open(id, url string, sequence uint64, frame Frame) (Receipt, error) {
	if id == "" {
		return Receipt{}, fmt.Errorf("browser id is required")
	}
	if err := frame.Validate(); err != nil {
		return Receipt{}, err
	}
	service.mu.Lock()
	window := service.window
	service.mu.Unlock()
	if window == nil || window() == nil {
		return Receipt{}, fmt.Errorf("native browser window is not ready")
	}
	native, err := createNativeBrowser(window(), url, frame)
	if err != nil {
		return Receipt{}, err
	}
	handle := service.install(id, native)
	applied := nativeBrowserFrame(native)
	service.mu.Lock()
	session := service.sessions[id]
	session.sequence = sequence
	session.requested = frame
	session.applied = applied
	service.mu.Unlock()
	return Receipt{Handle: handle, Sequence: sequence, Accepted: true, Requested: frame, Applied: applied}, nil
}

func (service *Service) SetFrame(handle Handle, sequence uint64, frame Frame) (Receipt, error) {
	if err := frame.Validate(); err != nil {
		return Receipt{}, err
	}
	service.mu.Lock()
	defer service.mu.Unlock()
	session := service.sessions[handle.ID]
	if session == nil || session.generation != handle.Generation || session.native == nil {
		return Receipt{}, fmt.Errorf("native browser does not exist: %s/%d", handle.ID, handle.Generation)
	}
	if sequence <= session.sequence {
		return Receipt{Handle: handle, Sequence: session.sequence, Accepted: false, Requested: session.requested, Applied: session.applied}, nil
	}
	setNativeBrowserFrame(session.native, frame)
	applied := nativeBrowserFrame(session.native)
	session.sequence = sequence
	session.requested = frame
	session.applied = applied
	return Receipt{Handle: handle, Sequence: sequence, Accepted: true, Requested: frame, Applied: applied}, nil
}

func (service *Service) Navigate(handle Handle, url string) error {
	session, err := service.current(handle)
	if err != nil {
		return err
	}
	return navigateNativeBrowser(session.native, url)
}

func (service *Service) Close(handle Handle) error {
	service.remove(handle.ID, handle.Generation)
	return nil
}
