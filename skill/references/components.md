# Components inside rich text

## In this file

- Why this needs its own commands
- How an instance is stored
- wf components used
- wf components migrate
- The property-id trap
- What this does not do

## Why this needs its own commands

Webflow can place a component inside a CMS rich-text field. The field then stores
the instance as **markup**, not as a reference. Nothing else in the API reports
it: a collection listing shows a rich-text field, and the component listing shows
a component, but neither says the two are connected.

So the only way to know which components a site's content depends on — or to
change one — is to read the field values and parse them.

## How an instance is stored

```html
<wf-component data-w-id="<instance>" component-id="<component>" name="FAQ item">
  <wf-prop name="<propertyId>" label="Title" type="text">A question</wf-prop>
  <wf-prop name="<propertyId>" label="Content" type="richtext"><p>An answer</p></wf-prop>
</wf-component>
```

Note `<wf-prop name>`. It holds the property's **ID**, not its label. That single
fact is why the migrate command exists and why it refuses as much as it does.

## wf components used

```bash
wf components used <siteId> [--collections a,b] [--json]
```

Read-only; `--dry` is refused. Reports every component placed inside a rich-text
field, how many instances exist, how many items they span, and which fields they
live in. Run it before changing or deleting a component, because a component used
only inside rich text looks unused everywhere else.

## wf components migrate

```bash
wf components migrate <siteId> --from <componentId> --to <componentId> --dry
wf components migrate <siteId> --from <componentId> --to <componentId> [--collections a,b]
```

Swaps one component for another everywhere it appears in rich text, across every
collection and item.

- **Always `--dry` first.** It prints the property mapping and every field that
  would change, and writes nothing.
- Properties are paired on **label and type together**. Label alone would pair a
  plain-text "Text" with a rich-text "Text" and quietly strip the markup.
- The component's `name` attribute is updated to the target's name.
- Only the attributes being changed are rewritten. Property values, the
  surrounding content and instances of other components are reassembled byte for
  byte.
- Each field is written, then proved against a fresh readback: no instance still
  references the old component, every property id belongs to the target, and
  every property value is still present. An unprovable write is
  `WF_WRITE_UNVERIFIED`.

## The property-id trap

This is the failure the command is built to prevent.

Two components can have properties with identical labels and types and still have
completely different property IDs. Swap `component-id` and leave `<wf-prop name>`
alone and the result **still renders** — as an instance of the new component with
every value empty, because none of those property IDs belong to it. No error, no
warning, and the content is gone from the field the next time anything writes it.

So the run refuses, as `WF_COMPONENT_PROP_UNMAPPED`, if any property on any
instance cannot be paired with one on the target. Add the missing properties to
the target component with matching labels and types, then re-run.

Properties that exist only on the target are reported too. Those are fine — they
simply start empty — but you should know they are there before you migrate.

## What this does not do

**It does not change where a component sits in the page.** Migrating the item
component in an accordion will not move a wrapper element, add one, or fix a
structure where each item wraps itself in something that belongs on the list. If
the target component carries markup that should appear once per list, every
instance will carry its own copy. Check the rendered result, not just the field.

**It does not create or edit components.** The target component must already
exist, built in the Designer, with the properties you expect.

**It does not touch component instances on static pages** — only those stored
inside CMS rich-text field values.
