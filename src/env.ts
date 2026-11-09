// Build mode, readable by both bundlers. Vite replaces process.env.NODE_ENV in
// dev and build; the add-on kit's Bun build defines it as "production".
// (import.meta.env is Vite-only, and `import.meta` has no meaning in the
// classic script a MnemoNexus pack runs as.)
export const DEV = process.env.NODE_ENV !== 'production'
