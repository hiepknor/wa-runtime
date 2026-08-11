# Repository guidance

## CodeGraph

This repository is indexed by CodeGraph. Before using grep/find or opening files to understand or
locate code, use:

```bash
codegraph explore "<symbols or question>"
```

Run `codegraph sync` after structural edits so later analysis uses current paths. The `.codegraph`
database is machine-local; only `.codegraph/.gitignore` is committed.

## Source boundaries

- `src/contracts` owns public API DTOs.
- `src/core` owns cross-cutting runtime infrastructure and must not depend on feature modules.
- `src/integrations` isolates third-party systems such as OpenWA.
- `src/modules` owns business features. Cross-feature dependencies must go through exported Nest
  providers and should follow a one-way dependency direction.
- `src/entrypoints` contains executable process bootstraps only; business logic belongs in modules.

Do not hand-edit generated OpenAPI snapshots or already-applied SQL migrations. Run `npm run check`
after each small refactor and regenerate the Runtime contract after controller or DTO changes.
