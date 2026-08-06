import { Polar } from "@polar-sh/sdk";

export type PolarServerMode = "sandbox" | "production";

/**
 * Sandbox in non-production; production when NODE_ENV=production unless
 * POLAR_SERVER explicitly overrides.
 */
export function getPolarServerMode(): PolarServerMode {
  const explicit = process.env.POLAR_SERVER?.trim().toLowerCase();
  if (explicit === "sandbox" || explicit === "production") {
    return explicit;
  }
  return process.env.NODE_ENV === "production" ? "production" : "sandbox";
}

let polarSingleton: Polar | null = null;
let polarSingletonMode: PolarServerMode | null = null;

/** Server-only Polar SDK. Do not import from client components. */
export function getPolarServer(): Polar {
  const accessToken = process.env.POLAR_ACCESS_TOKEN?.trim();
  if (!accessToken) {
    throw new Error("POLAR_ACCESS_TOKEN is not configured.");
  }

  const server = getPolarServerMode();
  if (!polarSingleton || polarSingletonMode !== server) {
    polarSingleton = new Polar({ accessToken, server });
    polarSingletonMode = server;
  }
  return polarSingleton;
}

export function getPolarProductId(): string {
  const id = process.env.POLAR_PRODUCT_ID?.trim();
  if (!id) {
    throw new Error("POLAR_PRODUCT_ID is not configured.");
  }
  return id;
}

/**
 * Slug of the Polar dashboard custom field used for VIN
 * (Settings → Custom Fields, then attach to the product checkout).
 */
export function getVinCustomFieldSlug(): string {
  const slug = process.env.POLAR_VIN_CUSTOM_FIELD_SLUG?.trim();
  return slug || "vin";
}

export function appOrigin(): string {
  const raw =
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_URL ||
    "http://localhost:3000";
  return raw.replace(/\/+$/, "");
}
