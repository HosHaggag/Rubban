package logging

import "runtime"

func runtimeUnix() bool { return runtime.GOOS != "windows" }
