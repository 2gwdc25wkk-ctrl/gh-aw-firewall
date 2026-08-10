package main

import (
	"fmt"
	"net"
	"path/filepath"
	"strconv"
	"strings"
)

type bootConfig struct {
	WorkspaceDevice string
	WorkspaceMount  string
	VsockPort       uint32
	GuestIP         net.IP
	GuestPrefix     int
	Gateway         net.IP
	Interface       string
	// Optional AWF-owned gh-aw runtime asset device. Read-only for the guest.
	RuntimeDevice string
	RuntimeMount  string
	RuntimeBinds  []runtimeBind
	// Optional bounded safe-output exchange device.
	ExchangeDevice string
	ExchangeMount  string
}

// runtimeBind maps one staged runtime asset subdirectory to a read-only guest path.
type runtimeBind struct {
	ID     string
	Target string
}

const maxRuntimeBinds = 8

func parseBootConfig(cmdline string) (bootConfig, error) {
	values := make(map[string]string)
	for _, token := range strings.Fields(cmdline) {
		key, value, ok := strings.Cut(token, "=")
		if !ok || !strings.HasPrefix(key, "awf.") {
			continue
		}
		if _, duplicate := values[key]; duplicate {
			return bootConfig{}, fmt.Errorf("duplicate boot argument %q", key)
		}
		values[key] = value
	}
	required := []string{
		"awf.workspace-device", "awf.workspace-mount", "awf.vsock-port",
		"awf.guest-ip", "awf.guest-prefix", "awf.guest-gateway", "awf.guest-interface",
	}
	for _, key := range required {
		if values[key] == "" {
			return bootConfig{}, fmt.Errorf("missing required boot argument %q", key)
		}
	}
	port, err := strconv.ParseUint(values["awf.vsock-port"], 10, 32)
	if err != nil || port == 0 {
		return bootConfig{}, fmt.Errorf("invalid awf.vsock-port")
	}
	prefix, err := strconv.Atoi(values["awf.guest-prefix"])
	if err != nil || prefix < 0 || prefix > 32 {
		return bootConfig{}, fmt.Errorf("invalid awf.guest-prefix")
	}
	ip := net.ParseIP(values["awf.guest-ip"]).To4()
	gateway := net.ParseIP(values["awf.guest-gateway"]).To4()
	if ip == nil || gateway == nil {
		return bootConfig{}, fmt.Errorf("guest IP and gateway must be IPv4 addresses")
	}
	device := values["awf.workspace-device"]
	if !strings.HasPrefix(device, "/dev/") || filepath.Clean(device) != device || strings.Contains(device, "..") {
		return bootConfig{}, fmt.Errorf("invalid awf.workspace-device")
	}
	mount := values["awf.workspace-mount"]
	if !filepath.IsAbs(mount) || filepath.Clean(mount) != mount || mount == "/" {
		return bootConfig{}, fmt.Errorf("invalid awf.workspace-mount")
	}
	iface := values["awf.guest-interface"]
	if !validInterface(iface) {
		return bootConfig{}, fmt.Errorf("invalid awf.guest-interface")
	}
	config := bootConfig{
		WorkspaceDevice: device, WorkspaceMount: mount, VsockPort: uint32(port),
		GuestIP: ip, GuestPrefix: prefix, Gateway: gateway, Interface: iface,
	}
	if err := parseOptionalDevices(values, &config); err != nil {
		return bootConfig{}, err
	}
	return config, nil
}

// parseOptionalDevices validates the optional runtime asset and exchange
// devices. They are optional so the existing minimal test rootfs, which never
// receives them, keeps booting unchanged.
func parseOptionalDevices(values map[string]string, config *bootConfig) error {
	occupied := []string{config.WorkspaceMount}

	runtimeDevice, runtimeMount := values["awf.runtime-device"], values["awf.runtime-mount"]
	binds := values["awf.runtime-bind"]
	if (runtimeDevice == "") != (runtimeMount == "") {
		return fmt.Errorf("awf.runtime-device and awf.runtime-mount must be set together")
	}
	if runtimeDevice == "" && binds != "" {
		return fmt.Errorf("awf.runtime-bind requires awf.runtime-device")
	}
	if runtimeDevice != "" {
		if err := validDevice(runtimeDevice, "awf.runtime-device"); err != nil {
			return err
		}
		if runtimeDevice == config.WorkspaceDevice {
			return fmt.Errorf("awf.runtime-device must differ from awf.workspace-device")
		}
		if err := validMountTarget(runtimeMount, "awf.runtime-mount", occupied); err != nil {
			return err
		}
		occupied = append(occupied, runtimeMount)
		config.RuntimeDevice, config.RuntimeMount = runtimeDevice, runtimeMount
	}
	if binds != "" {
		parsed, err := parseRuntimeBinds(binds, occupied)
		if err != nil {
			return err
		}
		config.RuntimeBinds = parsed
		for _, bind := range parsed {
			occupied = append(occupied, bind.Target)
		}
	}

	exchangeDevice, exchangeMount := values["awf.exchange-device"], values["awf.exchange-mount"]
	if (exchangeDevice == "") != (exchangeMount == "") {
		return fmt.Errorf("awf.exchange-device and awf.exchange-mount must be set together")
	}
	if exchangeDevice == "" {
		return nil
	}
	if err := validDevice(exchangeDevice, "awf.exchange-device"); err != nil {
		return err
	}
	if exchangeDevice == config.WorkspaceDevice || exchangeDevice == config.RuntimeDevice {
		return fmt.Errorf("awf.exchange-device must be a distinct block device")
	}
	if err := validMountTarget(exchangeMount, "awf.exchange-mount", occupied); err != nil {
		return err
	}
	config.ExchangeDevice, config.ExchangeMount = exchangeDevice, exchangeMount
	return nil
}

func parseRuntimeBinds(raw string, occupied []string) ([]runtimeBind, error) {
	fields := strings.Split(raw, ",")
	if len(fields) > maxRuntimeBinds {
		return nil, fmt.Errorf("awf.runtime-bind exceeds %d entries", maxRuntimeBinds)
	}
	seenIDs := make(map[string]struct{}, len(fields))
	binds := make([]runtimeBind, 0, len(fields))
	for _, field := range fields {
		id, target, ok := strings.Cut(field, ":")
		if !ok {
			return nil, fmt.Errorf("invalid awf.runtime-bind entry %q", field)
		}
		if !validBindID(id) {
			return nil, fmt.Errorf("invalid awf.runtime-bind id %q", id)
		}
		if _, duplicate := seenIDs[id]; duplicate {
			return nil, fmt.Errorf("duplicate awf.runtime-bind id %q", id)
		}
		seenIDs[id] = struct{}{}
		if err := validMountTarget(target, "awf.runtime-bind", occupied); err != nil {
			return nil, err
		}
		occupied = append(occupied, target)
		binds = append(binds, runtimeBind{ID: id, Target: target})
	}
	return binds, nil
}

func validDevice(device, name string) error {
	if !strings.HasPrefix(device, "/dev/") || filepath.Clean(device) != device ||
		strings.Contains(device, "..") {
		return fmt.Errorf("invalid %s", name)
	}
	return nil
}

// validMountTarget rejects non-canonical targets and any path that would nest
// inside (or contain) an already-claimed mount point.
func validMountTarget(target, name string, occupied []string) error {
	if !filepath.IsAbs(target) || filepath.Clean(target) != target || target == "/" {
		return fmt.Errorf("invalid %s target %q", name, target)
	}
	for _, existing := range occupied {
		if target == existing || isWithin(target, existing) || isWithin(existing, target) {
			return fmt.Errorf("%s target %q overlaps mount %q", name, target, existing)
		}
	}
	return nil
}

func isWithin(child, parent string) bool {
	return strings.HasPrefix(child, strings.TrimSuffix(parent, "/")+"/")
}

func validBindID(id string) bool {
	if id == "" || len(id) > 63 {
		return false
	}
	for i, r := range id {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
		case r == '-' && i > 0:
		default:
			return false
		}
	}
	return true
}

func validInterface(name string) bool {
	if name == "" || len(name) > 15 {
		return false
	}
	for i, r := range name {
		if !(r == '-' || r == '_' || r == '.' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || (i > 0 && r >= '0' && r <= '9')) {
			return false
		}
	}
	return true
}
