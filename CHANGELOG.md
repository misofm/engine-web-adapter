# Changelog

## Unreleased

- Preserve browser storage failures as `storage.io` with operation/resource/
  phase context and bounded nested causes; reserve `stem.corrupt` for verified
  digest or byte-length evidence and keep metadata/declaration failures
  distinct.
