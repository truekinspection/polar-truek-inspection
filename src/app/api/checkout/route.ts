import { Checkout } from "@polar-sh/nextjs";

import { appOrigin, getPolarServerMode } from "@/lib/polar";

/**
 * Official Polar Checkout adapter (unused by the Check VIN flow).
 * Primary app flow: POST /api/create-checkout + Polar Embedded Checkout.
 */
export const GET = Checkout({
  accessToken: process.env.POLAR_ACCESS_TOKEN,
  successUrl: `${appOrigin()}/report-preview?checkout_id={CHECKOUT_ID}`,
  returnUrl: `${appOrigin()}/check-vin`,
  server: getPolarServerMode(),
  theme: "light",
});
