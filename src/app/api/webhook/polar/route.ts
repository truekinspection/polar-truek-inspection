import { Webhooks } from "@polar-sh/nextjs";

import { fulfillPolarOrderPaid } from "@/actions/finalize-report-purchase";

export const POST = Webhooks({
  webhookSecret: process.env.POLAR_WEBHOOK_SECRET!,
  onOrderPaid: async (payload) => {
    const order = payload.data;
    try {
      const result = await fulfillPolarOrderPaid({
        orderId: order.id,
        checkoutId: order.checkoutId,
        metadata: order.metadata as Record<string, unknown>,
        customFieldData: (order.customFieldData ??
          null) as Record<string, unknown> | null,
        customerEmail: order.customer?.email ?? null,
        customerName: order.customer?.name ?? null,
      });
      if (!result.success) {
        console.error("[webhook/polar] fulfill failed:", result.error);
      }
    } catch (e) {
      // Never crash the webhook endpoint — Polar will retry on non-2xx;
      // adapter utils already acknowledge; we only log here.
      console.error("[webhook/polar] onOrderPaid error", e);
    }
  },
});
