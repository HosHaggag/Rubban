package main

import (
	"archive/zip"
	"bytes"
	"compress/flate"
	"hash/crc32"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"time"
)

type zipEntry struct {
	name     string // with the folder prefix; directories end in "/"
	abs      string
	mode     fs.FileMode
	modTime  time.Time
	isDir    bool
	linkDest string
	isLink   bool
}

// collectEntries lists folder and everything in it as <basename>/..., sorted by name at each level.
func collectEntries(folder string) ([]zipEntry, error) {
	folder, err := filepath.Abs(folder)
	if err != nil {
		return nil, err
	}
	var out []zipEntry
	var visit func(abs, name string) error
	visit = func(abs, name string) error {
		st, err := os.Lstat(abs)
		if err != nil {
			return err
		}
		switch {
		case st.Mode()&os.ModeSymlink != 0:
			target, err := os.Readlink(abs)
			if err != nil {
				return err
			}
			out = append(out, zipEntry{name: name, mode: 0o777 | fs.ModeSymlink, modTime: st.ModTime(), isLink: true, linkDest: target})
		case st.IsDir():
			mode := st.Mode().Perm()
			if mode == 0 {
				mode = 0o755
			}
			out = append(out, zipEntry{name: name + "/", mode: mode | fs.ModeDir, modTime: st.ModTime(), isDir: true})
			children, err := os.ReadDir(abs)
			if err != nil {
				return err
			}
			names := make([]string, 0, len(children))
			for _, c := range children {
				names = append(names, c.Name())
			}
			sort.Strings(names)
			for _, c := range names {
				if err := visit(filepath.Join(abs, c), name+"/"+c); err != nil {
					return err
				}
			}
		case st.Mode().IsRegular():
			mode := st.Mode().Perm()
			if mode == 0 {
				mode = 0o644
			}
			out = append(out, zipEntry{name: name, abs: abs, mode: mode, modTime: st.ModTime()})
		}
		return nil
	}
	if err := visit(folder, filepath.Base(folder)); err != nil {
		return nil, err
	}
	return out, nil
}

// zipDirectory writes folder to zipFile without needing an external zip command. Files are deflated
// only when that makes them smaller, Unix modes are kept and symlinks are stored as links.
func zipDirectory(folder, zipFile string) error {
	entries, err := collectEntries(folder)
	if err != nil {
		return err
	}
	_ = os.Remove(zipFile)
	f, err := os.Create(zipFile)
	if err != nil {
		return err
	}
	zw := zip.NewWriter(f)
	for _, e := range entries {
		h := &zip.FileHeader{Name: e.name, CreatorVersion: 3<<8 | 20}
		h.SetMode(e.mode)
		//lint:ignore SA1019 CreateRaw writes the legacy DOS fields only; Modified alone would be lost.
		h.SetModTime(e.modTime)
		switch {
		case e.isDir:
			h.Method = zip.Store
			if _, err := zw.CreateRaw(h); err != nil {
				return err
			}
			continue
		}
		var data []byte
		if e.isLink {
			data = []byte(e.linkDest)
		} else if data, err = os.ReadFile(e.abs); err != nil {
			return err
		}
		h.CRC32 = crc32.ChecksumIEEE(data)
		h.UncompressedSize64 = uint64(len(data))
		body, method := data, zip.Store
		if !e.isLink && len(data) > 0 {
			var buf bytes.Buffer
			fw, _ := flate.NewWriter(&buf, 6)
			_, _ = fw.Write(data)
			_ = fw.Close()
			if buf.Len() < len(data) {
				body, method = buf.Bytes(), zip.Deflate
			}
		}
		h.Method = method
		h.CompressedSize64 = uint64(len(body))
		w, err := zw.CreateRaw(h)
		if err != nil {
			return err
		}
		if _, err := io.Copy(w, bytes.NewReader(body)); err != nil {
			return err
		}
	}
	if err := zw.Close(); err != nil {
		return err
	}
	return f.Close()
}
