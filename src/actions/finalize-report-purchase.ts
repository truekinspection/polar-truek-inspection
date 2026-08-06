"use server";

import { randomBytes } from "crypto";
import db from "@/lib/db";
import { buildReportDeliveryEmailHtml } from "@/lib/emails/templates";
import { createResendClient, getResendFrom } from "@/lib/emails/resend-config";
import { sendOwnerCopy } from "@/lib/emails/send-owner-copy";
import { computeReportPreviewExpiry } from "@/lib/report-preview-access";
import { REPORT_PRICE_DISPLAY } from "@/lib/constants";
import { getPolarServer, getVinCustomFieldSlug } from "@/lib/polar";
import { fetchClearVinReport } from "@/actions/clearvin";
import { CheckoutStatus } from "@polar-sh/sdk/models/components/checkoutstatus";
import { normalizeVin } from "@/lib/vin-validation";

function generateToken(): string {
  return randomBytes(32).toString("hex");
}

function appOrigin(): string {
  const raw =
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_URL ||
    "https://www.truekinspection.com";
  return raw.replace(/\/+$/, "");
}

function splitCustomerName(displayName: string): {
  firstName: string;
  lastName: string;
} {
  const t = displayName.trim();
  if (!t) return { firstName: "Customer", lastName: "" };
  const parts = t.split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0]!, lastName: "" };
  return {
    firstName: parts[0]!,
    lastName: parts.slice(1).join(" "),
  };
}

function metaString(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
): string {
  const v = metadata?.[key];
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

function extractVin(
  customFieldData?: Record<string, unknown> | null,
  metadata?: Record<string, unknown> | null,
): string {
  const slug = getVinCustomFieldSlug();
  const fromCustom = metaString(customFieldData, slug);
  const fromMeta = metaString(metadata, "vin");
  const raw = fromCustom || fromMeta;
  return raw ? normalizeVin(raw) : "";
}

async function findExistingTokenForOrder(
  transactionId: string,
  vin: string,
): Promise<string | null> {
  const existing = await db.payment.findUnique({
    where: { orderID: transactionId },
  });
  if (!existing) return null;

  const tokenRow = await db.reportPreviewToken.findFirst({
    where: { vin: vin.trim() },
    orderBy: { createdAt: "desc" },
  });
  return tokenRow?.token ?? null;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function verifyPolarCheckout(
  checkoutId: string,
): Promise<
  | { ok: true; transactionId: string; checkoutId: string }
  | { ok: false; error: string }
> {
  const id = checkoutId.trim();
  if (!id) {
    return { ok: false, error: "Missing payment reference." };
  }

  try {
    const polar = getPolarServer();
    let lastStatus = "unknown";
    for (let attempt = 0; attempt < 8; attempt++) {
      const checkout = await polar.checkouts.get({ id });
      lastStatus = checkout.status;
      if (checkout.status === CheckoutStatus.Succeeded) {
        return {
          ok: true,
          transactionId: checkout.id,
          checkoutId: checkout.id,
        };
      }
      if (
        checkout.status === CheckoutStatus.Failed ||
        checkout.status === CheckoutStatus.Expired
      ) {
        break;
      }
      await sleep(500 * (attempt + 1));
    }
    return {
      ok: false,
      error: `Payment is not complete (status: ${lastStatus}).`,
    };
  } catch (e) {
    console.error("[finalizeReportPurchase] Polar verify failed", e);
    return { ok: false, error: "Could not verify payment with Polar." };
  }
}

async function persistAndEmail(params: {
  html: string;
  vin: string;
  clearvinReportId?: string | null;
  customerEmail: string;
  customerDisplayName: string;
  transactionId: string;
  vehicleYear?: string;
  vehicleMake?: string;
  vehicleModel?: string;
}): Promise<{ success: true; token: string } | { success: false; error: string }> {
  const email = params.customerEmail.trim();
  const vin = params.vin.trim();
  const transactionId = params.transactionId.trim();

  const existingToken = await findExistingTokenForOrder(transactionId, vin);
  if (existingToken) {
    return { success: true, token: existingToken };
  }

  const { firstName, lastName } = splitCustomerName(params.customerDisplayName);
  const token = generateToken();
  const expiresAt = computeReportPreviewExpiry();
  const reportIdStr = params.clearvinReportId?.trim() || null;

  try {
    await db.$transaction(
      async (tx) => {
        await tx.reportPreviewToken.create({
          data: {
            token,
            html: params.html,
            vin,
            clearvinReportId: reportIdStr,
            expiresAt,
          },
        });
        await tx.payment.create({
          data: {
            firstName,
            lastName,
            email,
            plan: `Vehicle History Report — ${REPORT_PRICE_DISPLAY}`,
            orderID: transactionId,
            status: "COMPLETED",
          },
        });
      },
      {
        maxWait: 20_000,
        timeout: 30_000,
      },
    );
  } catch (e) {
    const raced = await findExistingTokenForOrder(transactionId, vin);
    if (raced) {
      return { success: true, token: raced };
    }
    console.error("[finalizeReportPurchase] DB transaction failed", e);
    return {
      success: false,
      error: "We could not save your order. Please contact support.",
    };
  }

  const origin = appOrigin();
  const reportUrl = `${origin}/report-preview?token=${encodeURIComponent(token)}&vin=${encodeURIComponent(vin)}`;
  const resend = createResendClient();
  const from = getResendFrom();

  if (resend) {
    const customerLabel =
      [firstName, lastName].filter(Boolean).join(" ").trim() || "Customer";
    const emailHtml = buildReportDeliveryEmailHtml({
      customerName: customerLabel,
      reportUrl,
      vin,
      reportId: reportIdStr,
      transactionId,
      customerEmail: email,
      vehicleYear: params.vehicleYear,
      vehicleMake: params.vehicleMake,
      vehicleModel: params.vehicleModel,
    });

    try {
      await resend.emails.send({
        from,
        to: email,
        subject: "Your vehicle history report — TrueK Inspection",
        html: emailHtml,
      });
    } catch (err) {
      console.error("[finalizeReportPurchase] customer report email", err);
    }

    await sendOwnerCopy(resend, {
      customerEmail: email,
      subject: `[TrueK] Purchase complete — ${vin}`,
      html: buildReportDeliveryEmailHtml({
        customerName: customerLabel,
        reportUrl,
        vin,
        reportId: reportIdStr,
        transactionId,
        customerEmail: email,
        vehicleYear: params.vehicleYear,
        vehicleMake: params.vehicleMake,
        vehicleModel: params.vehicleModel,
        forOwner: true,
      }),
      logContext: "finalizeReportPurchase",
    });
  } else {
    console.warn(
      "[finalizeReportPurchase] RESEND_API_KEY not set; skipping emails.",
    );
  }

  void db.reportPreviewToken
    .deleteMany({ where: { expiresAt: { lt: new Date() } } })
    .catch(() => {});

  return { success: true, token };
}

async function fulfillPurchaseFromOrderData(input: {
  transactionId: string;
  checkoutId?: string | null;
  vin: string;
  customerEmail: string;
  customerDisplayName: string;
  vehicleYear?: string;
  vehicleMake?: string;
  vehicleModel?: string;
}): Promise<{ success: true; token: string } | { success: false; error: string }> {
  const vin = input.vin.trim();
  const email = input.customerEmail.trim();
  const transactionId = input.transactionId.trim();
  const checkoutId =
    typeof input.checkoutId === "string" ? input.checkoutId.trim() : "";

  if (!vin) {
    return { success: false, error: "VIN missing from order data." };
  }
  if (!email) {
    return { success: false, error: "Customer email missing from order." };
  }

  const existingByTx = await findExistingTokenForOrder(transactionId, vin);
  if (existingByTx) {
    return { success: true, token: existingByTx };
  }
  if (checkoutId && checkoutId !== transactionId) {
    const existingByCheckout = await findExistingTokenForOrder(checkoutId, vin);
    if (existingByCheckout) {
      return { success: true, token: existingByCheckout };
    }
  }

  const report = await fetchClearVinReport(vin);
  if (!report.success || !report.html) {
    console.error("[fulfillPurchase] ClearVIN:", report.error);
    return {
      success: false,
      error: report.error || "Failed to fetch ClearVIN report.",
    };
  }

  return persistAndEmail({
    html: report.html,
    vin,
    clearvinReportId: report.reportId,
    customerEmail: email,
    customerDisplayName: input.customerDisplayName,
    transactionId: checkoutId || transactionId,
    vehicleYear: input.vehicleYear,
    vehicleMake: input.vehicleMake,
    vehicleModel: input.vehicleModel,
  });
}

/**
 * Webhook fulfillment path: order.paid is already signature-verified.
 * Reads VIN from Polar custom fields (dashboard slug) or checkout metadata.
 */
export async function fulfillPolarOrderPaid(input: {
  orderId: string;
  checkoutId?: string | null;
  metadata?: Record<string, unknown> | null;
  customFieldData?: Record<string, unknown> | null;
  customerEmail?: string | null;
  customerName?: string | null;
}): Promise<{ success: true; token: string } | { success: false; error: string }> {
  const orderId = input.orderId.trim();
  if (!orderId) {
    return { success: false, error: "Missing order id." };
  }

  const metadata = input.metadata ?? {};
  const customFieldData = input.customFieldData ?? {};
  const vin = extractVin(customFieldData, metadata);
  const email =
    (typeof input.customerEmail === "string" && input.customerEmail.trim()) ||
    metaString(metadata, "email");
  const firstName = metaString(metadata, "firstName");
  const lastName = metaString(metadata, "lastName");
  const displayName =
    (typeof input.customerName === "string" && input.customerName.trim()) ||
    `${firstName} ${lastName}`.trim() ||
    "Customer";

  return fulfillPurchaseFromOrderData({
    transactionId: orderId,
    checkoutId: input.checkoutId,
    vin,
    customerEmail: email,
    customerDisplayName: displayName,
    vehicleYear: metaString(metadata, "vehicleYear") || undefined,
    vehicleMake: metaString(metadata, "vehicleMake") || undefined,
    vehicleModel: metaString(metadata, "vehicleModel") || undefined,
  });
}

/**
 * Called when Polar hosted checkout redirects to /report-preview?checkout_id=…
 * Verifies payment, fulfills if the webhook has not finished yet, returns token.
 */
export async function resolvePaidCheckout(
  checkoutId: string,
): Promise<
  | { success: true; token: string; vin: string }
  | { success: false; error: string }
> {
  const id = checkoutId.trim();
  if (!id) {
    return { success: false, error: "Missing checkout id." };
  }

  const verified = await verifyPolarCheckout(id);
  if (!verified.ok) {
    return { success: false, error: verified.error };
  }

  try {
    const polar = getPolarServer();
    const checkout = await polar.checkouts.get({ id });
    const metadata = (checkout.metadata ?? {}) as Record<string, unknown>;
    const customFieldData = (checkout.customFieldData ??
      {}) as Record<string, unknown>;
    const vin = extractVin(customFieldData, metadata);
    const email =
      (typeof checkout.customerEmail === "string" &&
        checkout.customerEmail.trim()) ||
      metaString(metadata, "email");
    const displayName =
      (typeof checkout.customerName === "string" &&
        checkout.customerName.trim()) ||
      `${metaString(metadata, "firstName")} ${metaString(metadata, "lastName")}`.trim() ||
      "Customer";

    if (!vin) {
      return {
        success: false,
        error: "VIN was not found on the paid checkout session.",
      };
    }

    const result = await fulfillPurchaseFromOrderData({
      transactionId: checkout.id,
      checkoutId: checkout.id,
      vin,
      customerEmail: email,
      customerDisplayName: displayName,
      vehicleYear: metaString(metadata, "vehicleYear") || undefined,
      vehicleMake: metaString(metadata, "vehicleMake") || undefined,
      vehicleModel: metaString(metadata, "vehicleModel") || undefined,
    });

    if (!result.success) {
      return result;
    }
    return { success: true, token: result.token, vin };
  } catch (e) {
    console.error("[resolvePaidCheckout]", e);
    return {
      success: false,
      error: "Could not prepare your report after payment.",
    };
  }
}
