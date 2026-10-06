// Package catalog turns the English UI strings into a translated catalog.
//
// ── The English source ──────────────────────────────────────────────────────
// Source reads the SAME namespace JSON files the client bundles
// (packages/app/src/i18n/locales/en/), copied into the image at build time,
// never fetched and never duplicated by hand. It is the only text this service
// will ever translate: a request names a locale, never text, so there is no
// path by which a task title, chat message or any other user content could
// reach Google through this service.
package catalog

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// leaf is one translatable string at a path inside a namespace's JSON tree.
type leaf struct {
	path []string
	text string
}

// Source is the loaded English catalog.
type Source struct {
	names  []string // sorted namespace names
	leaves map[string][]leaf
	tree   map[string]map[string]any
}

// LoadSource reads every *.json under dir (one file = one i18next namespace).
// It fails when there is nothing to translate: a gateway that cannot build a
// catalog must not report itself healthy.
func LoadSource(dir string) (*Source, error) {
	paths, err := filepath.Glob(filepath.Join(dir, "*.json"))
	if err != nil {
		return nil, err
	}
	if len(paths) == 0 {
		return nil, fmt.Errorf("no English catalog files in %q", dir)
	}
	sort.Strings(paths)
	s := &Source{leaves: map[string][]leaf{}, tree: map[string]map[string]any{}}
	for _, p := range paths {
		raw, err := os.ReadFile(p)
		if err != nil {
			return nil, err
		}
		var doc map[string]any
		if err := json.Unmarshal(raw, &doc); err != nil {
			return nil, fmt.Errorf("%s: %w", filepath.Base(p), err)
		}
		ns := strings.TrimSuffix(filepath.Base(p), ".json")
		var ls []leaf
		if err := collect(doc, nil, &ls); err != nil {
			return nil, fmt.Errorf("%s: %w", filepath.Base(p), err)
		}
		s.names = append(s.names, ns)
		s.leaves[ns] = ls
		s.tree[ns] = doc
	}
	return s, nil
}

func collect(node map[string]any, prefix []string, out *[]leaf) error {
	keys := make([]string, 0, len(node))
	for k := range node {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		path := append(append([]string(nil), prefix...), k)
		switch v := node[k].(type) {
		case string:
			*out = append(*out, leaf{path: path, text: v})
		case map[string]any:
			if err := collect(v, path, out); err != nil {
				return err
			}
		default:
			return fmt.Errorf("%s: only strings and objects are translatable, got %T", strings.Join(path, "."), v)
		}
	}
	return nil
}

// English returns the source tree as-is, namespace-shaped.
func (s *Source) English() map[string]any {
	out := make(map[string]any, len(s.tree))
	for ns, doc := range s.tree {
		out[ns] = doc
	}
	return out
}

// Strings returns every distinct source string across all namespaces, sorted,
// so the same English text ("Cancel", "Delete"…) is translated once.
func (s *Source) Strings() []string {
	seen := map[string]bool{}
	var out []string
	for _, ns := range s.names {
		for _, l := range s.leaves[ns] {
			if !seen[l.text] {
				seen[l.text] = true
				out = append(out, l.text)
			}
		}
	}
	sort.Strings(out)
	return out
}

// Apply rebuilds the namespace tree with each string replaced by
// translations[source], or by the English source itself when there is none.
func (s *Source) Apply(translations map[string]string) map[string]any {
	out := make(map[string]any, len(s.names))
	for _, ns := range s.names {
		root := map[string]any{}
		for _, l := range s.leaves[ns] {
			text, ok := translations[l.text]
			if !ok {
				text = l.text
			}
			node := root
			for _, part := range l.path[:len(l.path)-1] {
				next, _ := node[part].(map[string]any)
				if next == nil {
					next = map[string]any{}
					node[part] = next
				}
				node = next
			}
			node[l.path[len(l.path)-1]] = text
		}
		out[ns] = root
	}
	return out
}
