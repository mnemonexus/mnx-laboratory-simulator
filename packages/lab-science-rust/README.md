# Laboratory scientific numerics

Rust is the production numerical implementation, compiled to WebAssembly for the
shared browser application. WebGPU rendering and React/TypeScript orchestration
remain separate from these calculations.
The `extern "C"` declarations specify the export calling convention; the
numerical implementation is Rust.

From the repository root:

```powershell
rustup target add wasm32-unknown-unknown
npm run science:build
npm run science:test
npx vitest run src/runtime/rustScience.test.ts
npx vitest run src/runtime/rustFitting.test.ts
```

The build embeds the actual compiled binary and its SHA-256 into
`src/runtime/science.wasm.gen.ts`. The application awaits instantiation before
starting. An unavailable/unsupported module fails startup; production does not
silently choose the TypeScript reference implementation.

Binary ABI v4 uses owned Float64 scratch memory with explicit input/output
bounds. Models use mol/L, moles, kelvin, seconds, volts and joules. The bridge
refreshes memory views after calls that may allocate. Complexation and coupled
pH are whole numerical batches, with no JavaScript callbacks during iterations.
Nonlinear fits send paired observations once and copy results out after fitting;
the ABI documents undefined standard errors as NaN rather than false precision.

Implemented: plain pH, coupled metal/ligand speciation and pH, Nernst redox,
proton-transfer chemical enthalpy, bounded population increments, four-parameter
logistic calibration and Michaelis-Menten fitting. These
preserve the existing ideal educational models and their limitations; other
scientific modules and authoritative inventory/event transactions remain in the
existing core. Native analytical checks and browser-Wasm conformance comparisons
are both required before extending this list.

The logical `lab-numerics/1` model/save contract remains compatible. The binary
ABI version identifies exports and buffer layouts, not a new scientific model.
See `docs/framework/planning/technical-migration.md` for the migration record and
remaining work.
