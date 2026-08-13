# Choosing and setting up Webflow CMS

Use CMS when content changes often, repeats in the same shape, needs filtering
or sorting, is edited by non-developers, or needs its own generated pages. Keep
one-off or highly individual sections static. A static page can still contain
CMS lists such as testimonials.

## Check the site's real limits

Webflow changes plan limits. Check the site's current plan and the official
help pages before designing around a number.

- Imported `name` and `slug` values must be shorter than 256 characters. This
  import rule is not a limit for every Plain Text field. Use Rich Text for
  authored long-form content.
- Images are currently limited to 4MB each. A Multi-image field can hold 25
  images. Check current file limits before a bulk upload.
- Webflow currently documents up to 10 reference fields per Collection on
  non-Enterprise plans, depending on the plan, and 20 on Enterprise. Check
  Site settings → Plans → All site features before creating the fields.
- May 2026 plan changes move CMS and Business sites towards 20,000 CMS items.
  Existing sites change at renewal or another billable plan change, so inspect
  the actual site's plan.
- A page can currently contain up to 40 Collection lists, 10 nested lists and
  100 items in one list without pagination. These are maximums, not targets.
- Filtering and sorting vary by field type. Test the needed combination in the
  Designer before promising it.

Official help: [reference-field limits](https://help.webflow.com/hc/en-us/articles/33961317363091-Reference-Collection-field),
[dynamic-content limits](https://help.webflow.com/hc/en-us/articles/33961370432275-Dynamic-content-limits),
[Collection-list limits](https://help.webflow.com/hc/en-us/articles/33961368695827-Limit-Collection-lists),
[multi-image limits](https://help.webflow.com/hc/en-us/articles/33961308586899-Multi-image-field-overview),
and the [May 2026 plan change](https://help.webflow.com/hc/en-us/articles/51059955082387-Updated-pricing-and-simplified-plans-for-May-2026).

## CMS rules

- Choose the field type carefully. Changing it later can lose data.
- Use reference and multi-reference fields for relationships instead of copying
  names into Plain Text fields.
- Choose slugs carefully. Changing one later breaks the published URL.
- Read and write the correct locale. Do not overwrite translated content with
  default-locale content.
- Run `--check` before a bulk change and `--dry` to preview the exact request.
- Put every CMS field value inside `fieldData`. `wf items set` does this for you.
  For raw calls, use `wf fields <collectionId>` to get the real field slugs.
- Confirm the needed items exist before calling a listing page complete. Report
  an empty Collection rather than inventing client content.

