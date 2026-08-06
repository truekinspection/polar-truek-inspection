import { Checkout } from "@polar-sh/nextjs";

import { appOrigin, getPolarServerMode } from "@/lib/polar";

/**
 * Official Polar Checkout adapter (hosted redirect).
 * Primary app flow uses POST /api/create-checkout with customer + VIN prefills.
 */
export const GET = Checkout({
  accessToken: process.env.POLAR_ACCESS_TOKEN,
  successUrl: `${appOrigin()}/report-preview?checkout_id={CHECKOUT_ID}`,
  returnUrl: `${appOrigin()}/check-vin`,
  server: getPolarServerMode(),
  theme: "light",
});
