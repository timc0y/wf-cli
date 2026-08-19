# Internal link audit

Find links inside CMS content that point at this site but make the host correct
them on every visit.

```text
wf links audit <siteId> --hosts a.com,www.a.com
wf links audit <siteId> --hosts a.com,www.a.com --canonical www.a.com
wf links audit <siteId> --hosts a.com --related-hosts shop.a.com,othersite.example
wf links audit <siteId> --hosts a.com,old-domain.example --check-targets
wf links audit <siteId> --hosts a.com --collections articles,press
wf links audit <siteId> --hosts a.com --json
```

## In this file

- Why this matters after a migration
- Naming the site's domains
- Other sites you want counted but not touched
- What counts as a finding
- Checking the destinations
- What it deliberately leaves alone
- Options

## Why this matters after a migration

A content migration carries links across exactly as they were written on the old
site: as full URLs, often on the old domain, often ending in a slash. Every one
still works, so nothing appears broken and the problem stays invisible.

What happens on each visit is that the host corrects the link before serving the
page: it strips the trailing slash, upgrades `http` to `https`, then moves the
request to the canonical hostname. Each correction is a separate redirect. A
reader clicking an internal link can travel through three of them to reach a
page on the same site.

A root-relative link (`/sell-gold`) gives the host nothing to correct.

## Naming the site's domains

`--hosts` is required. It lists every hostname that counts as this site.

Nothing is inferred from the site record, for two reasons. The record only knows
the domains the site answers on *today*, while the links that matter most are
usually the ones still pointing at the domain the content was migrated *from*.
And a host set that is typed into the command is one a reader can check; an
inferred set quietly decides what counts as internal.

`--canonical` names the single host that links should use. Which variant that is
— the bare domain or the `www` one — is a per-site decision that reverses
freely, so it is never assumed. Any same-site link on a different host is
reported as `wrong-host`. Without `--canonical`, host variants are not judged at
all. The canonical host is part of the site by definition, so it does not need
repeating in `--hosts`.

The report echoes both back, because the host set decides every finding:

```text
treated as this site: a.com, old-domain.example, www.a.com  ·  canonical: www.a.com
```

## Other sites you want counted but not touched

`--related-hosts` names sites that should appear in the audit without ever being
rewritten: an old shop, a booking system, a sister brand.

They are held apart from the headline count, because they are not work on this
site, and folding them in would inflate the number someone estimates against.
They never carry a relative form either, and that is the point of the separate
input. `shop.a.com/product/x` is a different site: strip its host and the link
points at `a.com/product/x`, which is a different page or no page at all.

A host named in both `--hosts` and `--related-hosts` is refused rather than
guessed at.

## What counts as a finding

A link is reported when it points at one of the named hosts and is written in a
way the host has to correct:

| Finding | Meaning |
|---|---|
| `absolute` | Written as a full URL rather than a path. |
| `wrong-host` | A same-site link on a host other than the canonical one. |
| `trailing-slash` | The path ends in a slash, which the host strips. |
| `insecure` | Written as `http`, which the host upgrades. |

One link can carry several at once. Each finding also carries the same link
written root-relative, labelled `relative`. That is a restatement of the same
destination with the host and slash removed, not a proposal — the page it points
to does not change.

Findings are grouped by destination, because that is the unit a reviewer thinks
in: one destination linked fifty times is one decision, not fifty.

## Checking the destinations

`--check-targets` requests each distinct destination once and reports what it
returns. It is named for what it does: it never changes anything.

This separates two different problems. A link written badly still arrives; a
link to a dead path does not. A `404` is a broken link in published content,
whatever its shape. A `301` means the path has moved and something else is
catching it.

The status and any `Location` header are reported as facts. The command does not
follow a redirect to decide where a link ought to point instead, and it never
proposes a replacement destination — that is editorial judgement.

It talks to the public website rather than the Data API, so the site must be
published, and it is opt-in for that reason. Destinations are probed a few at a
time with a timeout, and `HEAD` is tried before `GET` in case the origin refuses
the method.

## What it deliberately leaves alone

- **Where a link ought to point instead.** It reports what a link *is*. Nothing
  in the output is a guess about a destination.
- **URLs written as visible text.** Only `href` attributes are read. A URL in a
  sentence is prose, and prose belongs to the author.
- **Links carrying a non-default port or a username.** Removing the host would
  change where they go, so they are not reported at all rather than reported
  wrongly.
- **Document-relative links** such as `../elsewhere`, whose meaning depends on
  the page they render on.
- **Anchors inside HTML comments**, and hrefs written without quotes. The
  command undercounts rather than guesses.
- **Designer content.** This reads CMS collection items. Links built into page
  components are a separate job.

## Options

| Option | Effect |
|---|---|
| `--hosts a.com,b.example` | Required. Every hostname that counts as this site. |
| `--canonical www.a.com` | The one host links should use. Without it, host variants are not judged. |
| `--related-hosts shop.a.com` | Other sites to report but never rewrite. |
| `--collections a,b` | Only these collections, by slug or id. |
| `--check-targets` | Request each destination and report its status. |
| `--json` | The full report, including every finding with its field, item and byte offsets. |

Read-only. The command never writes, so a read grant is enough.
