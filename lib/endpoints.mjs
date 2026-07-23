// Webflow Data API v2 endpoint catalog — generated from the official OpenAPI spec
// (github.com/webflow/openapi-spec, openapi/v2.yml). Powers `scripts/wf ls|find|call`.
// {group, name, method, path (with {params}), summary, scope}. Regenerate when the
// spec changes; this is a static snapshot for the local operator CLI.

export const ENDPOINTS = [
  {
    group: "activity_logs",
    name: "list",
    method: "GET",
    path: "/sites/{site_id}/activity_logs",
    summary: "Get Site Activity Logs",
    scope: "site_activity:read"
  },
  {
    group: "assets",
    name: "create",
    method: "POST",
    path: "/sites/{site_id}/assets",
    summary: "Upload Asset",
    scope: "assets:write"
  },
  {
    group: "assets",
    name: "create-folder",
    method: "POST",
    path: "/sites/{site_id}/asset_folders",
    summary: "Create Asset Folder",
    scope: "assets:write"
  },
  {
    group: "assets",
    name: "delete",
    method: "DELETE",
    path: "/assets/{asset_id}",
    summary: "Delete Asset",
    scope: "assets:write"
  },
  {
    group: "assets",
    name: "get",
    method: "GET",
    path: "/assets/{asset_id}",
    summary: "Get Asset",
    scope: "assets:read"
  },
  {
    group: "assets",
    name: "get-folder",
    method: "GET",
    path: "/asset_folders/{asset_folder_id}",
    summary: "Get Asset Folder",
    scope: "assets:read"
  },
  {
    group: "assets",
    name: "list",
    method: "GET",
    path: "/sites/{site_id}/assets",
    summary: "List Assets",
    scope: "assets:read"
  },
  {
    group: "assets",
    name: "list-folders",
    method: "GET",
    path: "/sites/{site_id}/asset_folders",
    summary: "List Asset Folders",
    scope: "assets:read"
  },
  {
    group: "assets",
    name: "update",
    method: "PATCH",
    path: "/assets/{asset_id}",
    summary: "Update Asset",
    scope: "assets:write"
  },
  {
    group: "collections",
    name: "create",
    method: "POST",
    path: "/sites/{site_id}/collections",
    summary: "Create Collection",
    scope: "cms:write"
  },
  {
    group: "collections",
    name: "delete",
    method: "DELETE",
    path: "/collections/{collection_id}",
    summary: "Delete Collection",
    scope: "cms:write"
  },
  {
    group: "collections",
    name: "get",
    method: "GET",
    path: "/collections/{collection_id}",
    summary: "Get Collection Details",
    scope: "cms:read"
  },
  {
    group: "collections",
    name: "list",
    method: "GET",
    path: "/sites/{site_id}/collections",
    summary: "List Collections",
    scope: "cms:read"
  },
  {
    group: "comments",
    name: "get-comment-thread",
    method: "GET",
    path: "/sites/{site_id}/comments/{comment_thread_id}",
    summary: "Get Comment Thread",
    scope: "comments:read"
  },
  {
    group: "comments",
    name: "list-comment-replies",
    method: "GET",
    path: "/sites/{site_id}/comments/{comment_thread_id}/replies",
    summary: "List Comment Replies",
    scope: "comments:read"
  },
  {
    group: "comments",
    name: "list-comment-threads",
    method: "GET",
    path: "/sites/{site_id}/comments",
    summary: "List Comment Threads",
    scope: "comments:read"
  },
  {
    group: "components",
    name: "get-content",
    method: "GET",
    path: "/sites/{site_id}/components/{component_id}/dom",
    summary: "Get Component Content",
    scope: "components:read"
  },
  {
    group: "components",
    name: "get-properties",
    method: "GET",
    path: "/sites/{site_id}/components/{component_id}/properties",
    summary: "Get Component Properties",
    scope: "components:read"
  },
  {
    group: "components",
    name: "list",
    method: "GET",
    path: "/sites/{site_id}/components",
    summary: "List Components",
    scope: "components:read"
  },
  {
    group: "components",
    name: "update-content",
    method: "POST",
    path: "/sites/{site_id}/components/{component_id}/dom",
    summary: "Update Component Content",
    scope: "components:write"
  },
  {
    group: "components",
    name: "update-properties",
    method: "POST",
    path: "/sites/{site_id}/components/{component_id}/properties",
    summary: "Update Component Properties",
    scope: "components:write"
  },
  {
    group: "custom_code",
    name: "delete-custom-code",
    method: "DELETE",
    path: "/pages/{page_id}/custom_code",
    summary: "Delete Custom Code",
    scope: "custom_code:write"
  },
  {
    group: "custom_code",
    name: "delete-custom-code",
    method: "DELETE",
    path: "/sites/{site_id}/custom_code",
    summary: "Delete Custom Code",
    scope: "custom_code:write"
  },
  {
    group: "custom_code",
    name: "get-custom-code",
    method: "GET",
    path: "/pages/{page_id}/custom_code",
    summary: "Get Custom Code",
    scope: "custom_code:read"
  },
  {
    group: "custom_code",
    name: "get-custom-code",
    method: "GET",
    path: "/sites/{site_id}/custom_code",
    summary: "Get Custom Code",
    scope: "custom_code:read"
  },
  {
    group: "custom_code",
    name: "list-custom-code-blocks",
    method: "GET",
    path: "/sites/{site_id}/custom_code/blocks",
    summary: "List Custom Code Blocks",
    scope: "custom_code:read"
  },
  {
    group: "custom_code",
    name: "upsert-custom-code",
    method: "PUT",
    path: "/pages/{page_id}/custom_code",
    summary: "Add/Update Custom Code",
    scope: "custom_code:write"
  },
  {
    group: "custom_code",
    name: "upsert-custom-code",
    method: "PUT",
    path: "/sites/{site_id}/custom_code",
    summary: "Add/Update Custom Code",
    scope: "custom_code:write"
  },
  {
    group: "custom_fonts",
    name: "batchDelete",
    method: "POST",
    path: "/sites/{site_id}/custom_fonts/batchDelete",
    summary: "Batch delete custom fonts",
    scope: "sites:write"
  },
  {
    group: "custom_fonts",
    name: "create",
    method: "POST",
    path: "/sites/{site_id}/custom_fonts",
    summary: "Create custom font",
    scope: "sites:write"
  },
  {
    group: "custom_fonts",
    name: "delete",
    method: "DELETE",
    path: "/sites/{site_id}/custom_fonts/{font_id}",
    summary: "Delete custom font",
    scope: "sites:write"
  },
  {
    group: "custom_fonts",
    name: "get",
    method: "GET",
    path: "/sites/{site_id}/custom_fonts/{font_id}",
    summary: "Get custom font",
    scope: "sites:read"
  },
  {
    group: "custom_fonts",
    name: "list",
    method: "GET",
    path: "/sites/{site_id}/custom_fonts",
    summary: "List custom fonts",
    scope: "sites:read"
  },
  {
    group: "custom_fonts",
    name: "replaceFile",
    method: "PUT",
    path: "/sites/{site_id}/custom_fonts/{font_id}/file",
    summary: "Replace custom font file",
    scope: "sites:write"
  },
  {
    group: "custom_fonts",
    name: "update",
    method: "PATCH",
    path: "/sites/{site_id}/custom_fonts/{font_id}",
    summary: "Update custom font",
    scope: "sites:write"
  },
  {
    group: "ecommerce",
    name: "get-settings",
    method: "GET",
    path: "/sites/{site_id}/ecommerce/settings",
    summary: "Get Ecommerce Settings",
    scope: "ecommerce:read"
  },
  {
    group: "fields",
    name: "create",
    method: "POST",
    path: "/collections/{collection_id}/fields",
    summary: "Create Collection Field",
    scope: "cms:write"
  },
  {
    group: "fields",
    name: "delete",
    method: "DELETE",
    path: "/collections/{collection_id}/fields/{field_id}",
    summary: "Delete Collection Field",
    scope: "cms:write"
  },
  {
    group: "fields",
    name: "update",
    method: "PATCH",
    path: "/collections/{collection_id}/fields/{field_id}",
    summary: "Update Collection Field",
    scope: "cms:write"
  },
  {
    group: "forms",
    name: "delete-submission",
    method: "DELETE",
    path: "/form_submissions/{form_submission_id}",
    summary: "Delete Form Submission",
    scope: "forms:write"
  },
  {
    group: "forms",
    name: "delete-submission",
    method: "DELETE",
    path: "/sites/{site_id}/form_submissions/{form_submission_id}",
    summary: "Delete Form Submission by Site",
    scope: "forms:write"
  },
  {
    group: "forms",
    name: "get",
    method: "GET",
    path: "/forms/{form_id}",
    summary: "Get Form Schema",
    scope: "forms:read"
  },
  {
    group: "forms",
    name: "get-submission",
    method: "GET",
    path: "/form_submissions/{form_submission_id}",
    summary: "Get Form Submission",
    scope: "forms:read"
  },
  {
    group: "forms",
    name: "get-submission",
    method: "GET",
    path: "/sites/{site_id}/form_submissions/{form_submission_id}",
    summary: "Get Form Submission by Site",
    scope: "forms:read"
  },
  {
    group: "forms",
    name: "list",
    method: "GET",
    path: "/sites/{site_id}/forms",
    summary: "List Forms",
    scope: "forms:read"
  },
  {
    group: "forms",
    name: "list-submissions",
    method: "GET",
    path: "/forms/{form_id}/submissions",
    summary: "List Form Submissions",
    scope: "forms:read"
  },
  {
    group: "forms",
    name: "list-submissions",
    method: "GET",
    path: "/sites/{site_id}/forms/{form_id}/submissions",
    summary: "List Form Submissions",
    scope: "forms:read"
  },
  {
    group: "forms",
    name: "list-submissions-by-site",
    method: "GET",
    path: "/sites/{site_id}/form_submissions",
    summary: "List Form Submissions by Site",
    scope: "forms:read"
  },
  {
    group: "forms",
    name: "update-submission",
    method: "PATCH",
    path: "/form_submissions/{form_submission_id}",
    summary: "Modify Form Submission",
    scope: "forms:write"
  },
  {
    group: "forms",
    name: "update-submission",
    method: "PATCH",
    path: "/sites/{site_id}/form_submissions/{form_submission_id}",
    summary: "Modify Form Submission by Site",
    scope: "forms:write"
  },
  {
    group: "google_tags",
    name: "delete",
    method: "DELETE",
    path: "/sites/{site_id}/integrations/google_tags/{tag_id}",
    summary: "Delete Google Tag",
    scope: "sites:write"
  },
  {
    group: "google_tags",
    name: "deleteAll",
    method: "DELETE",
    path: "/sites/{site_id}/integrations/google_tags",
    summary: "Delete Google Tags",
    scope: "sites:write"
  },
  {
    group: "google_tags",
    name: "list",
    method: "GET",
    path: "/sites/{site_id}/integrations/google_tags",
    summary: "List Google Tags",
    scope: "sites:read"
  },
  {
    group: "google_tags",
    name: "upsert",
    method: "PATCH",
    path: "/sites/{site_id}/integrations/google_tags",
    summary: "Update Google Tag",
    scope: "sites:write"
  },
  {
    group: "inventory",
    name: "list",
    method: "GET",
    path: "/collections/{sku_collection_id}/items/{sku_id}/inventory",
    summary: "List Inventory",
    scope: "ecommerce:read"
  },
  {
    group: "inventory",
    name: "update",
    method: "PATCH",
    path: "/collections/{sku_collection_id}/items/{sku_id}/inventory",
    summary: "Update Item Inventory",
    scope: "ecommerce:write"
  },
  {
    group: "items",
    name: "create-item",
    method: "POST",
    path: "/collections/{collection_id}/items",
    summary: "Create Collection Item(s)",
    scope: "cms:write"
  },
  {
    group: "items",
    name: "create-item-live",
    method: "POST",
    path: "/collections/{collection_id}/items/live",
    summary: "Create Live Collection Item(s)",
    scope: "cms:write"
  },
  {
    group: "items",
    name: "create-items",
    method: "POST",
    path: "/collections/{collection_id}/items/bulk",
    summary: "Create Collection Items",
    scope: "cms:write"
  },
  {
    group: "items",
    name: "delete-item",
    method: "DELETE",
    path: "/collections/{collection_id}/items/{item_id}",
    summary: "Delete Collection Item",
    scope: "cms:write"
  },
  {
    group: "items",
    name: "delete-item-live",
    method: "DELETE",
    path: "/collections/{collection_id}/items/{item_id}/live",
    summary: "Unpublish Live Collection Item",
    scope: "cms:write"
  },
  {
    group: "items",
    name: "delete-items",
    method: "DELETE",
    path: "/collections/{collection_id}/items",
    summary: "Delete Collection Items",
    scope: "cms:write"
  },
  {
    group: "items",
    name: "delete-items-live",
    method: "DELETE",
    path: "/collections/{collection_id}/items/live",
    summary: "Unpublish Live Collection Items",
    scope: "cms:write"
  },
  {
    group: "items",
    name: "get-item",
    method: "GET",
    path: "/collections/{collection_id}/items/{item_id}",
    summary: "Get Collection Item",
    scope: "cms:read"
  },
  {
    group: "items",
    name: "get-item-live",
    method: "GET",
    path: "/collections/{collection_id}/items/{item_id}/live",
    summary: "Get Live Collection Item",
    scope: "cms:read"
  },
  {
    group: "items",
    name: "list-items",
    method: "GET",
    path: "/collections/{collection_id}/items",
    summary: "List Collection Items",
    scope: "cms:read"
  },
  {
    group: "items",
    name: "list-items-live",
    method: "GET",
    path: "/collections/{collection_id}/items/live",
    summary: "List Live Collection Items",
    scope: "cms:read"
  },
  {
    group: "items",
    name: "publish-item",
    method: "POST",
    path: "/collections/{collection_id}/items/publish",
    summary: "Publish Collection Item",
    scope: "cms:write"
  },
  {
    group: "items",
    name: "update-item",
    method: "PATCH",
    path: "/collections/{collection_id}/items/{item_id}",
    summary: "Update Collection Item",
    scope: "cms:write"
  },
  {
    group: "items",
    name: "update-item-live",
    method: "PATCH",
    path: "/collections/{collection_id}/items/{item_id}/live",
    summary: "Update Live Collection Item",
    scope: "cms:write"
  },
  {
    group: "items",
    name: "update-items",
    method: "PATCH",
    path: "/collections/{collection_id}/items",
    summary: "Update Collection Items",
    scope: "cms:write"
  },
  {
    group: "items",
    name: "update-items-live",
    method: "PATCH",
    path: "/collections/{collection_id}/items/live",
    summary: "Update Live Collection Items",
    scope: "cms:write"
  },
  {
    group: "misc",
    name: "get-site-plan",
    method: "GET",
    path: "/sites/{site_id}/plan",
    summary: "Get Site Plan",
    scope: "sites:read"
  },
  {
    group: "orders",
    name: "get",
    method: "GET",
    path: "/sites/{site_id}/orders/{order_id}",
    summary: "Get Order",
    scope: "ecommerce:read"
  },
  {
    group: "orders",
    name: "list",
    method: "GET",
    path: "/sites/{site_id}/orders",
    summary: "List Orders",
    scope: "ecommerce:read"
  },
  {
    group: "orders",
    name: "refund",
    method: "POST",
    path: "/sites/{site_id}/orders/{order_id}/refund",
    summary: "Refund Order",
    scope: "ecommerce:write"
  },
  {
    group: "orders",
    name: "update",
    method: "PATCH",
    path: "/sites/{site_id}/orders/{order_id}",
    summary: "Update Order",
    scope: "ecommerce:write"
  },
  {
    group: "orders",
    name: "update-fulfill",
    method: "POST",
    path: "/sites/{site_id}/orders/{order_id}/fulfill",
    summary: "Fulfill Order",
    scope: "ecommerce:write"
  },
  {
    group: "orders",
    name: "update-unfulfill",
    method: "POST",
    path: "/sites/{site_id}/orders/{order_id}/unfulfill",
    summary: "Unfulfill Order",
    scope: "ecommerce:write"
  },
  {
    group: "pages",
    name: "get-content",
    method: "GET",
    path: "/pages/{page_id}/dom",
    summary: "Get Page Content",
    scope: "page:read"
  },
  {
    group: "pages",
    name: "get-metadata",
    method: "GET",
    path: "/pages/{page_id}",
    summary: "Get Page Metadata",
    scope: "page:read"
  },
  {
    group: "pages",
    name: "list",
    method: "GET",
    path: "/sites/{site_id}/pages",
    summary: "List Pages",
    scope: "page:read"
  },
  {
    group: "pages",
    name: "update-page-settings",
    method: "PUT",
    path: "/pages/{page_id}",
    summary: "Update Page Metadata",
    scope: "page:write"
  },
  {
    group: "pages",
    name: "update-static-content",
    method: "POST",
    path: "/pages/{page_id}/dom",
    summary: "Update Page Content",
    scope: "page:write"
  },
  {
    group: "products",
    name: "create",
    method: "POST",
    path: "/sites/{site_id}/products",
    summary: "Create Product & SKU",
    scope: "ecommerce:write"
  },
  {
    group: "products",
    name: "create-sku",
    method: "POST",
    path: "/sites/{site_id}/products/{product_id}/skus",
    summary: "Create SKUs",
    scope: "ecommerce:write"
  },
  {
    group: "products",
    name: "get",
    method: "GET",
    path: "/sites/{site_id}/products/{product_id}",
    summary: "Get Product and SKUs",
    scope: "ecommerce:read"
  },
  {
    group: "products",
    name: "list",
    method: "GET",
    path: "/sites/{site_id}/products",
    summary: "List Products & SKUs",
    scope: "ecommerce:read"
  },
  {
    group: "products",
    name: "update",
    method: "PATCH",
    path: "/sites/{site_id}/products/{product_id}",
    summary: "Update Product",
    scope: "ecommerce:write"
  },
  {
    group: "products",
    name: "update-sku",
    method: "PATCH",
    path: "/sites/{site_id}/products/{product_id}/skus/{sku_id}",
    summary: "Update SKU",
    scope: "ecommerce:write"
  },
  {
    group: "redirects",
    name: "create",
    method: "POST",
    path: "/sites/{site_id}/redirects",
    summary: "Create a 301 redirect",
    scope: "sites:write"
  },
  {
    group: "redirects",
    name: "delete",
    method: "DELETE",
    path: "/sites/{site_id}/redirects/{redirect_id}",
    summary: "Delete 301 redirects",
    scope: "sites:write"
  },
  {
    group: "redirects",
    name: "list",
    method: "GET",
    path: "/sites/{site_id}/redirects",
    summary: "Get 301 redirects",
    scope: "sites:read"
  },
  {
    group: "redirects",
    name: "update",
    method: "PATCH",
    path: "/sites/{site_id}/redirects/{redirect_id}",
    summary: "Update 301 redirect",
    scope: "sites:write"
  },
  {
    group: "robots",
    name: "delete",
    method: "DELETE",
    path: "/sites/{site_id}/robots_txt",
    summary: "Delete robots.txt",
    scope: "site_config:write"
  },
  {
    group: "robots",
    name: "get",
    method: "GET",
    path: "/sites/{site_id}/robots_txt",
    summary: "Get robots.txt",
    scope: "site_config:read"
  },
  {
    group: "robots",
    name: "patch",
    method: "PATCH",
    path: "/sites/{site_id}/robots_txt",
    summary: "Update robots.txt",
    scope: "site_config:write"
  },
  {
    group: "robots",
    name: "put",
    method: "PUT",
    path: "/sites/{site_id}/robots_txt",
    summary: "Replace robots.txt",
    scope: "site_config:write"
  },
  {
    group: "scripts",
    name: "list",
    method: "GET",
    path: "/sites/{site_id}/registered_scripts",
    summary: "Get Registered Scripts",
    scope: "custom_code:read"
  },
  {
    group: "scripts",
    name: "register-hosted",
    method: "POST",
    path: "/sites/{site_id}/registered_scripts/hosted",
    summary: "Register Script - Hosted",
    scope: "custom_code:write"
  },
  {
    group: "scripts",
    name: "register-inline",
    method: "POST",
    path: "/sites/{site_id}/registered_scripts/inline",
    summary: "Register Script - Inline",
    scope: "custom_code:write"
  },
  {
    group: "sites",
    name: "create",
    method: "POST",
    path: "/workspaces/{workspace_id}/sites",
    summary: "Create Site",
    scope: "sites:write"
  },
  {
    group: "sites",
    name: "delete",
    method: "DELETE",
    path: "/sites/{site_id}",
    summary: "Delete Site",
    scope: "sites:write"
  },
  {
    group: "sites",
    name: "get",
    method: "GET",
    path: "/sites/{site_id}",
    summary: "Get Site",
    scope: "sites:read"
  },
  {
    group: "sites",
    name: "get-custom-domain",
    method: "GET",
    path: "/sites/{site_id}/custom_domains",
    summary: "Get Custom Domains",
    scope: "sites:read"
  },
  {
    group: "sites",
    name: "list",
    method: "GET",
    path: "/sites",
    summary: "List Sites",
    scope: "sites:read"
  },
  {
    group: "sites",
    name: "publish",
    method: "POST",
    path: "/sites/{site_id}/publish",
    summary: "Publish Site",
    scope: "sites:write"
  },
  {
    group: "sites",
    name: "update",
    method: "PATCH",
    path: "/sites/{site_id}",
    summary: "Update Site",
    scope: "sites:write"
  },
  {
    group: "token",
    name: "authorized-by",
    method: "GET",
    path: "/token/authorized_by",
    summary: "Get Authorization User Info",
    scope: "authorized_user:read"
  },
  {
    group: "token",
    name: "introspect",
    method: "GET",
    path: "/token/introspect",
    summary: "Get Authorization Info",
    scope: ""
  },
  {
    group: "webhooks",
    name: "create",
    method: "POST",
    path: "/sites/{site_id}/webhooks",
    summary: "Create Webhook",
    scope: ""
  },
  {
    group: "webhooks",
    name: "delete",
    method: "DELETE",
    path: "/webhooks/{webhook_id}",
    summary: "Remove Webhook",
    scope: ""
  },
  {
    group: "webhooks",
    name: "get",
    method: "GET",
    path: "/webhooks/{webhook_id}",
    summary: "Get Webhook",
    scope: ""
  },
  {
    group: "webhooks",
    name: "list",
    method: "GET",
    path: "/sites/{site_id}/webhooks",
    summary: "List Webhooks",
    scope: ""
  },
  {
    group: "well_known",
    name: "delete",
    method: "DELETE",
    path: "/sites/{site_id}/well_known",
    summary: "Delete a well-known file",
    scope: "site_config:write"
  },
  {
    group: "well_known",
    name: "put",
    method: "PUT",
    path: "/sites/{site_id}/well_known",
    summary: "Set a well-known file",
    scope: "site_config:write"
  },
  {
    group: "workspaces",
    name: "get-workspace-audit_logs",
    method: "GET",
    path: "/workspaces/{workspace_id_or_slug}/audit_logs",
    summary: "Get Workspace Audit Logs",
    scope: "workspace_activity:read"
  }
];
