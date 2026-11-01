# datacenter-fabric

A generic leaf/spine topology (2 spines, 4 leaves, 2 edge firewalls, 8
compute hosts, 20 links) used to exercise clab-view's topology diagram
against a real containerlab YAML rather than a hand-placed mock.

Every node is a plain container (no KVM/VM dependency), so it deploys with
just containerlab and Docker:

```
containerlab deploy -t examples/datacenter-fabric/topology.clab.yml
```

and tears down with:

```
containerlab destroy -t examples/datacenter-fabric/topology.clab.yml
```

## Viewing it in clab-view

Point clab-view at this lab through either data source:

- `CONTAINERLAB_SOURCE=clab-api` against a running `containerlab tools
  api-server` for this lab, or
- `CONTAINERLAB_SOURCE=plugin` against a device plugin that passes through
  this lab's `containerlab inspect --format json` and this file's content
  as `clab_yaml` (see docs/plugin-contract.md). `inspect.json` in this
  directory is exactly that output, hand-written to match this topology
  (all 16 nodes `running`) rather than captured from a live lab, so this
  works without ever having deployed the lab at all:

  ```
  CLAB_YAML_FILE=examples/datacenter-fabric/topology.clab.yml \
  INSPECT_JSON_FILE=examples/datacenter-fabric/inspect.json \
    go run ./examples/example-plugin
  ```

  then point clab-view's `PLUGIN_BASE_URL` at it with `CONTAINERLAB_SOURCE=plugin`.
  If the lab actually is deployed (see above), replace `inspect.json` with
  the real `containerlab inspect --format json` output for a live view
  instead.

No Sakutei or plugin-specific resource overlay is attached to this
topology — it is for exercising the containerlab-only diagram, independent
of anything else clab-view can optionally overlay.
