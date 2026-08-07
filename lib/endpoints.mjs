// Webflow Data API v2 endpoint catalog — generated from the official OpenAPI spec
// (github.com/webflow/openapi-spec, openapi/v2.yml). Powers `scripts/wf ls|find|call`.
// {group, name, method, path (with {params}), summary}. Regenerate when the
// spec changes; this is a static snapshot for the local operator CLI. (The
// spec's OAuth `scope` strings were stripped — nothing reads them.)

export const ENDPOINTS = [
  {
    group: "activity_logs",
    name: "list",
    method: "GET",
    path: "/sites/{site_id}/activity_logs",
    summary: "Get Site Activity Logs"
  },
  {
    group: "assets",
    name: "create",
    method: "POST",
    path: "/sites/{site_id}/assets",
    summary: "Upload Asset"
  },
  {
    group: "assets",
    name: "create-folder",
    method: "POST",
    path: "/sites/{site_id}/asset_folders",
    summary: "Create Asset Folder"
  },
  {
    group: "assets",
    name: "delete",
    method: "DELETE",
    path: "/assets/{asset_id}",
    summary: "Delete Asset"
  },
  {
    group: "assets",
    name: "get",
    method: "GET",
    path: "/assets/{asset_id}",
    summary: "Get Asset"
  },
  {
    group: "assets",
    name: "get-folder",
    method: "GET",
    path: "/asset_folders/{asset_folder_id}",
    summary: "Get Asset Folder"
  },
  {
    group: "assets",
    name: "list",
    method: "GET",
    path: "/sites/{site_id}/assets",
    summary: "List Assets"
  },
  {
    group: "assets",
    name: "list-folders",
    method: "GET",
    path: "/sites/{site_id}/asset_folders",
    summary: "List Asset Folders"
  },
  {
    group: "assets",
    name: "update",
    method: "PATCH",
    path: "/assets/{asset_id}",
    summary: "Update Asset"
  },
  {
    group: "collections",
    name: "create",
    method: "POST",
    path: "/sites/{site_id}/collections",
    summary: "Create Collection"
  },
  {
    group: "collections",
    name: "delete",
    method: "DELETE",
    path: "/collections/{collection_id}",
    summary: "Delete Collection"
  },
  {
    group: "collections",
    name: "get",
    method: "GET",
    path: "/collections/{collection_id}",
    summary: "Get Collection Details"
  },
  {
    group: "collections",
    name: "list",
    method: "GET",
    path: "/sites/{site_id}/collections",
    summary: "List Collections"
  },
  {
    group: "comments",
    name: "get-comment-thread",
    method: "GET",
    path: "/sites/{site_id}/comments/{comment_thread_id}",
    summary: "Get Comment Thread"
  },
  {
    group: "comments",
    name: "list-comment-replies",
    method: "GET",
    path: "/sites/{site_id}/comments/{comment_thread_id}/replies",
    summary: "List Comment Replies"
  },
  {
    group: "comments",
    name: "list-comment-threads",
    method: "GET",
    path: "/sites/{site_id}/comments",
    summary: "List Comment Threads"
  },
  {
    group: "components",
    name: "get-content",
    method: "GET",
    path: "/sites/{site_id}/components/{component_id}/dom",
    summary: "Get Component Content"
  },
  {
    group: "components",
    name: "get-properties",
    method: "GET",
    path: "/sites/{site_id}/components/{component_id}/properties",
    summary: "Get Component Properties"
  },
  {
    group: "components",
    name: "list",
    method: "GET",
    path: "/sites/{site_id}/components",
    summary: "List Components"
  },
  {
    group: "components",
    name: "update-content",
    method: "POST",
    path: "/sites/{site_id}/components/{component_id}/dom",
    summary: "Update Component Content"
  },
  {
    group: "components",
    name: "update-properties",
    method: "POST",
    path: "/sites/{site_id}/components/{component_id}/properties",
    summary: "Update Component Properties"
  },
  {
    group: "custom_code",
    name: "delete-custom-code",
    method: "DELETE",
    path: "/pages/{page_id}/custom_code",
    summary: "Delete Custom Code"
  },
  {
    group: "custom_code",
    name: "delete-custom-code",
    method: "DELETE",
    path: "/sites/{site_id}/custom_code",
    summary: "Delete Custom Code"
  },
  {
    group: "custom_code",
    name: "get-custom-code",
    method: "GET",
    path: "/pages/{page_id}/custom_code",
    summary: "Get Custom Code"
  },
  {
    group: "custom_code",
    name: "get-custom-code",
    method: "GET",
    path: "/sites/{site_id}/custom_code",
    summary: "Get Custom Code"
  },
  {
    group: "custom_code",
    name: "list-custom-code-blocks",
    method: "GET",
    path: "/sites/{site_id}/custom_code/blocks",
    summary: "List Custom Code Blocks"
  },
  {
    group: "custom_code",
    name: "upsert-custom-code",
    method: "PUT",
    path: "/pages/{page_id}/custom_code",
    summary: "Add/Update Custom Code"
  },
  {
    group: "custom_code",
    name: "upsert-custom-code",
    method: "PUT",
    path: "/sites/{site_id}/custom_code",
    summary: "Add/Update Custom Code"
  },
  {
    group: "custom_fonts",
    name: "batchDelete",
    method: "POST",
    path: "/sites/{site_id}/custom_fonts/batchDelete",
    summary: "Batch delete custom fonts"
  },
  {
    group: "custom_fonts",
    name: "create",
    method: "POST",
    path: "/sites/{site_id}/custom_fonts",
    summary: "Create custom font"
  },
  {
    group: "custom_fonts",
    name: "delete",
    method: "DELETE",
    path: "/sites/{site_id}/custom_fonts/{font_id}",
    summary: "Delete custom font"
  },
  {
    group: "custom_fonts",
    name: "get",
    method: "GET",
    path: "/sites/{site_id}/custom_fonts/{font_id}",
    summary: "Get custom font"
  },
  {
    group: "custom_fonts",
    name: "list",
    method: "GET",
    path: "/sites/{site_id}/custom_fonts",
    summary: "List custom fonts"
  },
  {
    group: "custom_fonts",
    name: "replaceFile",
    method: "PUT",
    path: "/sites/{site_id}/custom_fonts/{font_id}/file",
    summary: "Replace custom font file"
  },
  {
    group: "custom_fonts",
    name: "update",
    method: "PATCH",
    path: "/sites/{site_id}/custom_fonts/{font_id}",
    summary: "Update custom font"
  },
  {
    group: "ecommerce",
    name: "get-settings",
    method: "GET",
    path: "/sites/{site_id}/ecommerce/settings",
    summary: "Get Ecommerce Settings"
  },
  {
    group: "fields",
    name: "create",
    method: "POST",
    path: "/collections/{collection_id}/fields",
    summary: "Create Collection Field"
  },
  {
    group: "fields",
    name: "delete",
    method: "DELETE",
    path: "/collections/{collection_id}/fields/{field_id}",
    summary: "Delete Collection Field"
  },
  {
    group: "fields",
    name: "update",
    method: "PATCH",
    path: "/collections/{collection_id}/fields/{field_id}",
    summary: "Update Collection Field"
  },
  {
    group: "forms",
    name: "delete-submission",
    method: "DELETE",
    path: "/form_submissions/{form_submission_id}",
    summary: "Delete Form Submission"
  },
  {
    group: "forms",
    name: "delete-submission",
    method: "DELETE",
    path: "/sites/{site_id}/form_submissions/{form_submission_id}",
    summary: "Delete Form Submission by Site"
  },
  {
    group: "forms",
    name: "get",
    method: "GET",
    path: "/forms/{form_id}",
    summary: "Get Form Schema"
  },
  {
    group: "forms",
    name: "get-submission",
    method: "GET",
    path: "/form_submissions/{form_submission_id}",
    summary: "Get Form Submission"
  },
  {
    group: "forms",
    name: "get-submission",
    method: "GET",
    path: "/sites/{site_id}/form_submissions/{form_submission_id}",
    summary: "Get Form Submission by Site"
  },
  {
    group: "forms",
    name: "list",
    method: "GET",
    path: "/sites/{site_id}/forms",
    summary: "List Forms"
  },
  {
    group: "forms",
    name: "list-submissions",
    method: "GET",
    path: "/forms/{form_id}/submissions",
    summary: "List Form Submissions"
  },
  {
    group: "forms",
    name: "list-submissions",
    method: "GET",
    path: "/sites/{site_id}/forms/{form_id}/submissions",
    summary: "List Form Submissions"
  },
  {
    group: "forms",
    name: "list-submissions-by-site",
    method: "GET",
    path: "/sites/{site_id}/form_submissions",
    summary: "List Form Submissions by Site"
  },
  {
    group: "forms",
    name: "update-submission",
    method: "PATCH",
    path: "/form_submissions/{form_submission_id}",
    summary: "Modify Form Submission"
  },
  {
    group: "forms",
    name: "update-submission",
    method: "PATCH",
    path: "/sites/{site_id}/form_submissions/{form_submission_id}",
    summary: "Modify Form Submission by Site"
  },
  {
    group: "google_tags",
    name: "delete",
    method: "DELETE",
    path: "/sites/{site_id}/integrations/google_tags/{tag_id}",
    summary: "Delete Google Tag"
  },
  {
    group: "google_tags",
    name: "deleteAll",
    method: "DELETE",
    path: "/sites/{site_id}/integrations/google_tags",
    summary: "Delete Google Tags"
  },
  {
    group: "google_tags",
    name: "list",
    method: "GET",
    path: "/sites/{site_id}/integrations/google_tags",
    summary: "List Google Tags"
  },
  {
    group: "google_tags",
    name: "upsert",
    method: "PATCH",
    path: "/sites/{site_id}/integrations/google_tags",
    summary: "Update Google Tag"
  },
  {
    group: "inventory",
    name: "list",
    method: "GET",
    path: "/collections/{sku_collection_id}/items/{sku_id}/inventory",
    summary: "List Inventory"
  },
  {
    group: "inventory",
    name: "update",
    method: "PATCH",
    path: "/collections/{sku_collection_id}/items/{sku_id}/inventory",
    summary: "Update Item Inventory"
  },
  {
    group: "items",
    name: "create-item",
    method: "POST",
    path: "/collections/{collection_id}/items",
    summary: "Create Collection Item(s)"
  },
  {
    group: "items",
    name: "create-item-live",
    method: "POST",
    path: "/collections/{collection_id}/items/live",
    summary: "Create Live Collection Item(s)"
  },
  {
    group: "items",
    name: "create-items",
    method: "POST",
    path: "/collections/{collection_id}/items/bulk",
    summary: "Create Collection Items"
  },
  {
    group: "items",
    name: "delete-item",
    method: "DELETE",
    path: "/collections/{collection_id}/items/{item_id}",
    summary: "Delete Collection Item"
  },
  {
    group: "items",
    name: "delete-item-live",
    method: "DELETE",
    path: "/collections/{collection_id}/items/{item_id}/live",
    summary: "Unpublish Live Collection Item"
  },
  {
    group: "items",
    name: "delete-items",
    method: "DELETE",
    path: "/collections/{collection_id}/items",
    summary: "Delete Collection Items"
  },
  {
    group: "items",
    name: "delete-items-live",
    method: "DELETE",
    path: "/collections/{collection_id}/items/live",
    summary: "Unpublish Live Collection Items"
  },
  {
    group: "items",
    name: "get-item",
    method: "GET",
    path: "/collections/{collection_id}/items/{item_id}",
    summary: "Get Collection Item"
  },
  {
    group: "items",
    name: "get-item-live",
    method: "GET",
    path: "/collections/{collection_id}/items/{item_id}/live",
    summary: "Get Live Collection Item"
  },
  {
    group: "items",
    name: "list-items",
    method: "GET",
    path: "/collections/{collection_id}/items",
    summary: "List Collection Items"
  },
  {
    group: "items",
    name: "list-items-live",
    method: "GET",
    path: "/collections/{collection_id}/items/live",
    summary: "List Live Collection Items"
  },
  {
    group: "items",
    name: "publish-item",
    method: "POST",
    path: "/collections/{collection_id}/items/publish",
    summary: "Publish Collection Item"
  },
  {
    group: "items",
    name: "update-item",
    method: "PATCH",
    path: "/collections/{collection_id}/items/{item_id}",
    summary: "Update Collection Item"
  },
  {
    group: "items",
    name: "update-item-live",
    method: "PATCH",
    path: "/collections/{collection_id}/items/{item_id}/live",
    summary: "Update Live Collection Item"
  },
  {
    group: "items",
    name: "update-items",
    method: "PATCH",
    path: "/collections/{collection_id}/items",
    summary: "Update Collection Items"
  },
  {
    group: "items",
    name: "update-items-live",
    method: "PATCH",
    path: "/collections/{collection_id}/items/live",
    summary: "Update Live Collection Items"
  },
  {
    group: "misc",
    name: "get-site-plan",
    method: "GET",
    path: "/sites/{site_id}/plan",
    summary: "Get Site Plan"
  },
  {
    group: "orders",
    name: "get",
    method: "GET",
    path: "/sites/{site_id}/orders/{order_id}",
    summary: "Get Order"
  },
  {
    group: "orders",
    name: "list",
    method: "GET",
    path: "/sites/{site_id}/orders",
    summary: "List Orders"
  },
  {
    group: "orders",
    name: "refund",
    method: "POST",
    path: "/sites/{site_id}/orders/{order_id}/refund",
    summary: "Refund Order"
  },
  {
    group: "orders",
    name: "update",
    method: "PATCH",
    path: "/sites/{site_id}/orders/{order_id}",
    summary: "Update Order"
  },
  {
    group: "orders",
    name: "update-fulfill",
    method: "POST",
    path: "/sites/{site_id}/orders/{order_id}/fulfill",
    summary: "Fulfill Order"
  },
  {
    group: "orders",
    name: "update-unfulfill",
    method: "POST",
    path: "/sites/{site_id}/orders/{order_id}/unfulfill",
    summary: "Unfulfill Order"
  },
  {
    group: "pages",
    name: "get-content",
    method: "GET",
    path: "/pages/{page_id}/dom",
    summary: "Get Page Content"
  },
  {
    group: "pages",
    name: "get-metadata",
    method: "GET",
    path: "/pages/{page_id}",
    summary: "Get Page Metadata"
  },
  {
    group: "pages",
    name: "list",
    method: "GET",
    path: "/sites/{site_id}/pages",
    summary: "List Pages"
  },
  {
    group: "pages",
    name: "update-page-settings",
    method: "PUT",
    path: "/pages/{page_id}",
    summary: "Update Page Metadata"
  },
  {
    group: "pages",
    name: "update-static-content",
    method: "POST",
    path: "/pages/{page_id}/dom",
    summary: "Update Page Content"
  },
  {
    group: "products",
    name: "create",
    method: "POST",
    path: "/sites/{site_id}/products",
    summary: "Create Product & SKU"
  },
  {
    group: "products",
    name: "create-sku",
    method: "POST",
    path: "/sites/{site_id}/products/{product_id}/skus",
    summary: "Create SKUs"
  },
  {
    group: "products",
    name: "get",
    method: "GET",
    path: "/sites/{site_id}/products/{product_id}",
    summary: "Get Product and SKUs"
  },
  {
    group: "products",
    name: "list",
    method: "GET",
    path: "/sites/{site_id}/products",
    summary: "List Products & SKUs"
  },
  {
    group: "products",
    name: "update",
    method: "PATCH",
    path: "/sites/{site_id}/products/{product_id}",
    summary: "Update Product"
  },
  {
    group: "products",
    name: "update-sku",
    method: "PATCH",
    path: "/sites/{site_id}/products/{product_id}/skus/{sku_id}",
    summary: "Update SKU"
  },
  {
    group: "redirects",
    name: "create",
    method: "POST",
    path: "/sites/{site_id}/redirects",
    summary: "Create a 301 redirect"
  },
  {
    group: "redirects",
    name: "delete",
    method: "DELETE",
    path: "/sites/{site_id}/redirects/{redirect_id}",
    summary: "Delete 301 redirects"
  },
  {
    group: "redirects",
    name: "list",
    method: "GET",
    path: "/sites/{site_id}/redirects",
    summary: "Get 301 redirects"
  },
  {
    group: "redirects",
    name: "update",
    method: "PATCH",
    path: "/sites/{site_id}/redirects/{redirect_id}",
    summary: "Update 301 redirect"
  },
  {
    group: "robots",
    name: "delete",
    method: "DELETE",
    path: "/sites/{site_id}/robots_txt",
    summary: "Delete robots.txt"
  },
  {
    group: "robots",
    name: "get",
    method: "GET",
    path: "/sites/{site_id}/robots_txt",
    summary: "Get robots.txt"
  },
  {
    group: "robots",
    name: "patch",
    method: "PATCH",
    path: "/sites/{site_id}/robots_txt",
    summary: "Update robots.txt"
  },
  {
    group: "robots",
    name: "put",
    method: "PUT",
    path: "/sites/{site_id}/robots_txt",
    summary: "Replace robots.txt"
  },
  {
    group: "scripts",
    name: "list",
    method: "GET",
    path: "/sites/{site_id}/registered_scripts",
    summary: "Get Registered Scripts"
  },
  {
    group: "scripts",
    name: "register-hosted",
    method: "POST",
    path: "/sites/{site_id}/registered_scripts/hosted",
    summary: "Register Script - Hosted"
  },
  {
    group: "scripts",
    name: "register-inline",
    method: "POST",
    path: "/sites/{site_id}/registered_scripts/inline",
    summary: "Register Script - Inline"
  },
  {
    group: "sites",
    name: "create",
    method: "POST",
    path: "/workspaces/{workspace_id}/sites",
    summary: "Create Site"
  },
  {
    group: "sites",
    name: "delete",
    method: "DELETE",
    path: "/sites/{site_id}",
    summary: "Delete Site"
  },
  {
    group: "sites",
    name: "get",
    method: "GET",
    path: "/sites/{site_id}",
    summary: "Get Site"
  },
  {
    group: "sites",
    name: "get-custom-domain",
    method: "GET",
    path: "/sites/{site_id}/custom_domains",
    summary: "Get Custom Domains"
  },
  {
    group: "sites",
    name: "list",
    method: "GET",
    path: "/sites",
    summary: "List Sites"
  },
  {
    group: "sites",
    name: "publish",
    method: "POST",
    path: "/sites/{site_id}/publish",
    summary: "Publish Site"
  },
  {
    group: "sites",
    name: "update",
    method: "PATCH",
    path: "/sites/{site_id}",
    summary: "Update Site"
  },
  {
    group: "token",
    name: "authorized-by",
    method: "GET",
    path: "/token/authorized_by",
    summary: "Get Authorization User Info"
  },
  {
    group: "token",
    name: "introspect",
    method: "GET",
    path: "/token/introspect",
    summary: "Get Authorization Info"
  },
  {
    group: "webhooks",
    name: "create",
    method: "POST",
    path: "/sites/{site_id}/webhooks",
    summary: "Create Webhook"
  },
  {
    group: "webhooks",
    name: "delete",
    method: "DELETE",
    path: "/webhooks/{webhook_id}",
    summary: "Remove Webhook"
  },
  {
    group: "webhooks",
    name: "get",
    method: "GET",
    path: "/webhooks/{webhook_id}",
    summary: "Get Webhook"
  },
  {
    group: "webhooks",
    name: "list",
    method: "GET",
    path: "/sites/{site_id}/webhooks",
    summary: "List Webhooks"
  },
  {
    group: "well_known",
    name: "delete",
    method: "DELETE",
    path: "/sites/{site_id}/well_known",
    summary: "Delete a well-known file"
  },
  {
    group: "well_known",
    name: "put",
    method: "PUT",
    path: "/sites/{site_id}/well_known",
    summary: "Set a well-known file"
  },
  {
    group: "workspaces",
    name: "get-workspace-audit_logs",
    method: "GET",
    path: "/workspaces/{workspace_id_or_slug}/audit_logs",
    summary: "Get Workspace Audit Logs"
  }
];
