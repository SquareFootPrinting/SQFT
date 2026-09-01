# Square Foot Printing — production checkout checklist

Implemented in this build:

1. Orders now persist delivery method, shipping address/service/cost, payment method, tracking number and carrier in MongoDB.
2. UPS rating endpoint added at `POST /api/shipping/ups-rates`. Returned rates are signed and expire after 15 minutes; checkout must submit the signed rate back with the order.
3. Server recalculates production-type minimums and the final total before saving an order; Stripe charges the total stored on the MongoDB order.
4. Stripe success page added as `order-confirmation.html`.
6. Admin order details now show payment, delivery, shipping address/cost, transaction ID and allow saving a UPS tracking number.
8. New-order notification recipient moved to `ORDER_NOTIFICATION_EMAIL`.

## Render variables still required for live services

UPS:
- `UPS_CLIENT_ID`
- `UPS_CLIENT_SECRET`
- `UPS_ACCOUNT_NUMBER`
- `UPS_ORIGIN_ZIP`
- `UPS_DEFAULT_WEIGHT_LBS` (temporary default package weight until product packaging dimensions/weights are modeled)
- `UPS_ENV=production`
- `SHIPPING_QUOTE_SECRET` (long random secret)



Email:
- `ORDER_NOTIFICATION_EMAIL`

## Important price-validation note

This build removes trust in the browser's *final total*: the server recomputes production minimums, validates the signed UPS amount, stores its own final total, and Stripe charges that stored total.

Individual product calculators are still distributed across the product HTML/JavaScript files. Therefore each submitted line item's calculated `price` is not yet independently reconstructed from `pricingcatalogs` by the backend. Full authoritative line-item validation requires moving/duplicating each product calculator formula into a shared server pricing engine. Do that before treating the checkout as tamper-proof for public production traffic.
