# Server-side pricing migration status

## Protected now
- Gallery Canvas (`gallery-canvas`): server recalculates price from MongoDB `largeFormatPricing.gallery-canvas.sizes`, authenticated retail/wholesale tier, quantity, and turnaround. Browser `item.price` is ignored and the authoritative price is stored on the order.

## Still to migrate
Other product calculators still use legacy submitted line price plus server-side production minimum validation. They must be migrated product-by-product before Stripe Live Mode.
