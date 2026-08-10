package main

import "testing"

const validCmdline = "console=ttyS0 awf.workspace-device=/dev/vdb awf.workspace-mount=/workspace awf.vsock-port=1024 awf.guest-ip=192.0.2.2 awf.guest-prefix=24 awf.guest-gateway=192.0.2.1 awf.guest-interface=eth0"

func TestParseBootConfig(t *testing.T) {
	config, err := parseBootConfig(validCmdline)
	if err != nil {
		t.Fatalf("parseBootConfig: %v", err)
	}
	if config.VsockPort != 1024 || config.Interface != "eth0" || config.GuestIP.String() != "192.0.2.2" {
		t.Fatalf("unexpected config: %#v", config)
	}
}

func TestParseBootConfigRejectsUnsafeValues(t *testing.T) {
	cases := []string{
		"awf.workspace-device=/dev/vdb awf.workspace-mount=/workspace awf.vsock-port=0 awf.guest-ip=192.0.2.2 awf.guest-prefix=24 awf.guest-gateway=192.0.2.1 awf.guest-interface=eth0",
		"awf.workspace-device=/dev/../etc/passwd awf.workspace-mount=/workspace awf.vsock-port=1 awf.guest-ip=192.0.2.2 awf.guest-prefix=24 awf.guest-gateway=192.0.2.1 awf.guest-interface=eth0",
		"awf.workspace-device=/dev/vdb awf.workspace-mount=/ awf.vsock-port=1 awf.guest-ip=192.0.2.2 awf.guest-prefix=24 awf.guest-gateway=192.0.2.1 awf.guest-interface=eth0",
		"awf.workspace-device=/dev/vdb awf.workspace-mount=/workspace awf.vsock-port=1 awf.guest-ip=bad awf.guest-prefix=24 awf.guest-gateway=192.0.2.1 awf.guest-interface=eth0",
	}
	for _, cmdline := range cases {
		if _, err := parseBootConfig(cmdline); err == nil {
			t.Errorf("unsafe command line accepted: %q", cmdline)
		}
	}
}

func TestParseBootConfigRejectsDuplicateArguments(t *testing.T) {
	if _, err := parseBootConfig(validCmdline + " awf.vsock-port=1025"); err == nil {
		t.Fatal("duplicate argument accepted")
	}
}

const validOptionalDevices = " awf.runtime-device=/dev/vdc awf.runtime-mount=/awf/runtime" +
	" awf.runtime-bind=gh-aw-runner-temp:/awf/runner-temp/gh-aw,gh-aw-tmp:/tmp/gh-aw" +
	" awf.exchange-device=/dev/vdd awf.exchange-mount=/awf/exchange"

func TestParseBootConfigOptionalDevicesAbsentByDefault(t *testing.T) {
	config, err := parseBootConfig(validCmdline)
	if err != nil {
		t.Fatalf("parseBootConfig: %v", err)
	}
	if config.RuntimeDevice != "" || config.RuntimeMount != "" || len(config.RuntimeBinds) != 0 {
		t.Fatalf("runtime device unexpectedly set: %#v", config)
	}
	if config.ExchangeDevice != "" || config.ExchangeMount != "" {
		t.Fatalf("exchange device unexpectedly set: %#v", config)
	}
}

func TestParseBootConfigParsesOptionalDevices(t *testing.T) {
	config, err := parseBootConfig(validCmdline + validOptionalDevices)
	if err != nil {
		t.Fatalf("parseBootConfig: %v", err)
	}
	if config.RuntimeDevice != "/dev/vdc" || config.RuntimeMount != "/awf/runtime" {
		t.Fatalf("unexpected runtime config: %#v", config)
	}
	if len(config.RuntimeBinds) != 2 {
		t.Fatalf("unexpected bind count: %#v", config.RuntimeBinds)
	}
	if config.RuntimeBinds[0].ID != "gh-aw-runner-temp" ||
		config.RuntimeBinds[0].Target != "/awf/runner-temp/gh-aw" {
		t.Fatalf("unexpected first bind: %#v", config.RuntimeBinds[0])
	}
	if config.RuntimeBinds[1].Target != "/tmp/gh-aw" {
		t.Fatalf("unexpected second bind: %#v", config.RuntimeBinds[1])
	}
	if config.ExchangeDevice != "/dev/vdd" || config.ExchangeMount != "/awf/exchange" {
		t.Fatalf("unexpected exchange config: %#v", config)
	}
}

func TestParseBootConfigRejectsUnsafeOptionalDevices(t *testing.T) {
	cases := map[string]string{
		"runtime device without mount":     " awf.runtime-device=/dev/vdc",
		"runtime mount without device":     " awf.runtime-mount=/awf/runtime",
		"bind without device":              " awf.runtime-bind=gh-aw-tmp:/tmp/gh-aw",
		"runtime device path traversal":    " awf.runtime-device=/dev/../etc/shadow awf.runtime-mount=/awf/runtime",
		"runtime device aliases workspace": " awf.runtime-device=/dev/vdb awf.runtime-mount=/awf/runtime",
		"runtime mount is root":            " awf.runtime-device=/dev/vdc awf.runtime-mount=/",
		"runtime mount overlaps workspace": " awf.runtime-device=/dev/vdc awf.runtime-mount=/workspace/runtime",
		"bind escapes into workspace": " awf.runtime-device=/dev/vdc awf.runtime-mount=/awf/runtime" +
			" awf.runtime-bind=gh-aw-tmp:/workspace/gh-aw",
		"bind is relative": " awf.runtime-device=/dev/vdc awf.runtime-mount=/awf/runtime" +
			" awf.runtime-bind=gh-aw-tmp:tmp/gh-aw",
		"bind traverses": " awf.runtime-device=/dev/vdc awf.runtime-mount=/awf/runtime" +
			" awf.runtime-bind=gh-aw-tmp:/tmp/../etc",
		"bind id invalid": " awf.runtime-device=/dev/vdc awf.runtime-mount=/awf/runtime" +
			" awf.runtime-bind=../evil:/tmp/gh-aw",
		"bind id uppercase": " awf.runtime-device=/dev/vdc awf.runtime-mount=/awf/runtime" +
			" awf.runtime-bind=GhAw:/tmp/gh-aw",
		"bind missing target": " awf.runtime-device=/dev/vdc awf.runtime-mount=/awf/runtime" +
			" awf.runtime-bind=gh-aw-tmp",
		"duplicate bind ids": " awf.runtime-device=/dev/vdc awf.runtime-mount=/awf/runtime" +
			" awf.runtime-bind=gh-aw-tmp:/tmp/gh-aw,gh-aw-tmp:/tmp/other",
		"duplicate bind targets": " awf.runtime-device=/dev/vdc awf.runtime-mount=/awf/runtime" +
			" awf.runtime-bind=gh-aw-tmp:/tmp/gh-aw,gh-aw-other:/tmp/gh-aw",
		"nested bind targets": " awf.runtime-device=/dev/vdc awf.runtime-mount=/awf/runtime" +
			" awf.runtime-bind=gh-aw-tmp:/tmp/gh-aw,gh-aw-other:/tmp/gh-aw/nested",
		"too many binds": " awf.runtime-device=/dev/vdc awf.runtime-mount=/awf/runtime" +
			" awf.runtime-bind=a:/tmp/a,b:/tmp/b,c:/tmp/c,d:/tmp/d,e:/tmp/e,f:/tmp/f,g:/tmp/g,h:/tmp/h,i:/tmp/i",
		"exchange device without mount":     " awf.exchange-device=/dev/vdd",
		"exchange mount without device":     " awf.exchange-mount=/awf/exchange",
		"exchange aliases workspace device": " awf.exchange-device=/dev/vdb awf.exchange-mount=/awf/exchange",
		"exchange overlaps workspace mount": " awf.exchange-device=/dev/vdd awf.exchange-mount=/workspace",
	}
	for name, suffix := range cases {
		if _, err := parseBootConfig(validCmdline + suffix); err == nil {
			t.Errorf("%s: unsafe command line accepted", name)
		}
	}
}

func TestParseBootConfigRejectsExchangeAliasingRuntimeDevice(t *testing.T) {
	cmdline := validCmdline +
		" awf.runtime-device=/dev/vdc awf.runtime-mount=/awf/runtime" +
		" awf.exchange-device=/dev/vdc awf.exchange-mount=/awf/exchange"
	if _, err := parseBootConfig(cmdline); err == nil {
		t.Fatal("aliased runtime and exchange devices accepted")
	}
}
