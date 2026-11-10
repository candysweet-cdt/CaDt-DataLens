//go:build !windows

package main

import "context"

func applyTaskbarIcon() {}

func showWindowWhenReady(ctx context.Context) {}

func ensureWindowShown(ctx context.Context) {}
