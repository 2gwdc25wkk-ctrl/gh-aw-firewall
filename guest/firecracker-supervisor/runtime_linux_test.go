//go:build linux

package main

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func TestResolveCommandUsesRequestPath(t *testing.T) {
	directory := t.TempDir()
	commandPath := filepath.Join(directory, "demo")
	if err := os.WriteFile(commandPath, []byte("#!/bin/sh\n"), 0700); err != nil {
		t.Fatalf("write command: %v", err)
	}
	resolved, err := resolveCommand("demo", map[string]string{"PATH": directory})
	if err != nil {
		t.Fatalf("resolve command: %v", err)
	}
	if resolved != commandPath {
		t.Fatalf("resolved command mismatch: got %s want %s", resolved, commandPath)
	}
}

func TestResolveCommandRejectsRelativeExecutablePath(t *testing.T) {
	if _, err := resolveCommand("./demo", map[string]string{"PATH": "/usr/bin"}); err == nil {
		t.Fatal("expected relative executable path to fail")
	}
}

func TestUnmountPlanIsExactReverseOfMountOrder(t *testing.T) {
	config := bootConfig{
		WorkspaceMount: "/workspace",
		RuntimeMount:   "/awf/runtime",
		ExchangeMount:  "/awf/exchange",
		RuntimeBinds: []runtimeBind{
			{ID: "runner-temp", Target: "/awf/runner-temp/gh-aw"},
			{ID: "compiler-tmp", Target: "/tmp/gh-aw"},
		},
	}

	want := []string{
		"/awf/exchange",
		"/tmp/gh-aw",
		"/awf/runner-temp/gh-aw",
		"/awf/runtime",
		"/workspace",
	}
	plan := unmountPlan(config)
	if len(plan) != len(want) {
		t.Fatalf("unmount plan length = %d, want %d", len(plan), len(want))
	}
	for i, step := range plan {
		if step.Target != want[i] {
			t.Fatalf("unmount plan[%d] = %q, want %q", i, step.Target, want[i])
		}
	}
}

func TestUnmountPlanSkipsAbsentOptionalDevices(t *testing.T) {
	// A workspace-only guest must still produce a valid, workspace-last plan.
	plan := unmountPlan(bootConfig{WorkspaceMount: "/workspace"})
	if len(plan) != 1 || plan[0].Target != "/workspace" {
		t.Fatalf("unmount plan = %+v, want workspace only", plan)
	}
}

// The workspace is the only writable guest filesystem, so it must never permit
// setuid or device nodes. MS_NOEXEC must stay off because builds and tests run
// binaries out of the workspace.
func TestWorkspaceMountFlagsBlockPrivilegeVectors(t *testing.T) {
	if workspaceMountFlags&syscall.MS_NOSUID == 0 {
		t.Fatal("workspace mount must set MS_NOSUID")
	}
	if workspaceMountFlags&syscall.MS_NODEV == 0 {
		t.Fatal("workspace mount must set MS_NODEV")
	}
	if workspaceMountFlags&syscall.MS_NOEXEC != 0 {
		t.Fatal("workspace mount must not set MS_NOEXEC")
	}
	if workspaceMountFlags&syscall.MS_RDONLY != 0 {
		t.Fatal("workspace mount must stay writable for copy-back")
	}
}
