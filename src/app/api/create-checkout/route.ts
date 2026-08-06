import { NextResponse } from "next/server";

import {
  appOrigin,
  getPolarProductId,
  getPolarServer,
  getVinCustomFieldSlug,
} from "@/lib/polar";

export async function POST(request: Request) {
  try {
    if (!process.env.POLAR_ACCESS_TOKEN?.trim()) {
      return NextResponse.json(
        { success: false, message: "Polar is not configured." },
        { status: 500 },
      );
    }

    let productId: string;
    try {
      productId = getPolarProductId();
    } catch {
      return NextResponse.json(
        { success: false, message: "Polar product is not configured." },
        { status: 500 },
      );
    }

    const body = await request.json();
    const firstName =
      typeof body.firstName === "string" ? body.firstName.trim() : "";
    const lastName =
      typeof body.lastName === "string" ? body.lastName.trim() : "";
    const email = typeof body.email === "string" ? body.email.trim() : "";
    const vin = typeof body.vin === "string" ? body.vin.trim().toUpperCase() : "";
    const vehicleYear =
      typeof body.vehicleYear === "string" ? body.vehicleYear.trim() : "";
    const vehicleMake =
      typeof body.vehicleMake === "string" ? body.vehicleMake.trim() : "";
    const vehicleModel =
      typeof body.vehicleModel === "string" ? body.vehicleModel.trim() : "";

    if (!firstName || !lastName || !email || !vin) {
      return NextResponse.json(
        { success: false, message: "Missing required fields." },
        { status: 400 },
      );
    }

    const origin = appOrigin();
    const customerName = `${firstName} ${lastName}`.trim();
    const vinFieldSlug = getVinCustomFieldSlug();
    const forwarded = request.headers.get("x-forwarded-for");
    const customerIp =
      forwarded?.split(",")[0]?.trim() ||
      request.headers.get("x-real-ip") ||
      undefined;

    const polar = getPolarServer();
    const checkout = await polar.checkouts.create({
      products: [productId],
      customerEmail: email,
      customerName,
      customerIpAddress: customerIp ?? null,
      // Hosted checkout: Polar redirects here after successful payment.
      successUrl: `${origin}/report-preview?checkout_id={CHECKOUT_ID}`,
      returnUrl: `${origin}/check-vin`,
      // Prefill Polar dashboard custom field (slug must match dashboard config).
      customFieldData: {
        [vinFieldSlug]: vin,
      },
      // Also store on metadata so webhooks can always recover VIN / vehicle info.
      metadata: {
        vin,
        firstName,
        lastName,
        email,
        ...(vehicleYear ? { vehicleYear } : {}),
        ...(vehicleMake ? { vehicleMake } : {}),
        ...(vehicleModel ? { vehicleModel } : {}),
      },
    });

    if (!checkout.url) {
      return NextResponse.json(
        { success: false, message: "Could not create checkout session." },
        { status: 500 },
      );
    }

    return NextResponse.json({
      success: true,
      checkoutId: checkout.id,
      checkoutUrl: checkout.url,
    });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error("[create-checkout]", err.message || error);
    return NextResponse.json(
      {
        success: false,
        message: "Could not create checkout session.",
        details: err.message,
      },
      { status: 500 },
    );
  }
}
