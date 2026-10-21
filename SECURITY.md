# Security

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository rather than a public issue.

## What a run can do

agent-horde runs several pi agents ("members") as child processes of your pi session, in your
working directory, with the model and tool permissions that session has. Treat a run as you would
treat running that agent yourself, several times in parallel:

- **Members execute tools.** They read and write under the working directory and run whatever
  commands the session allows. Start runs only in projects you trust, and review ledger output
  (`.horde/*.md`, `.horde/runs/<id>/`) the way you review any agent output before acting on it.
- **Members influence each other.** Board posts, findings, peer messages, and attached evidence are
  written by one model and read by others. The member protocol labels them untrusted data and
  forbids them from authorizing tools, but that is an instruction to a model, not an enforcement
  boundary. Prompt injection through the ledgers is a known risk of any multi-agent setup, including
  injection that arrives from the target under study: a repository, a web page, a document.
- **Resource cleanup runs commands.** A member may claim a shared resource with a `cleanup`
  command; the parent runs those commands at finalize (`PI_HORDE_CLEANUP=off` skips them). Claims
  are recorded in `RESOURCES.md` and in the run's event log before anything runs.
- **Run directories hold full transcripts.** `.horde/runs/<id>/` keeps every member session, the
  event log, and published artifacts, including anything a member saw or produced. Keep `.horde/`
  out of version control.

## The dashboard

`--dashboard` serves `.horde/` over HTTP on `127.0.0.1` only. It answers GET and HEAD, never
writes, rejects requests whose `Host` header is not localhost, sends a `default-src 'none'` content
security policy, and renders no scripts. It still exposes everything under `.horde/` to any process
or browser tab on the machine, member transcripts included. Do not forward or proxy the port.

`/export.zip` packs every dashboard page, transcripts and logs included, into one archive meant
to be shared. The export control warns before the download, but the archive carries whatever the
members read or produced: file contents, command output, paths, and any credentials they met.
Review it before passing it on.

## Supply chain

The package has no runtime dependencies beyond the packages pi itself provides to extensions.
Development dependencies are pinned to exact versions.
