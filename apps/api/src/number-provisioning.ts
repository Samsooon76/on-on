import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";
import twilio from "twilio";
import { numberCountrySchema, numberPurchaseSchema, uuidSchema, type Database, type NumberOrder } from "@onoff/contracts";
import type { AppConfig } from "./config.js";
import { isActiveOrganizationAdmin } from "./repositories/access.js";

type Quote = Database["public"]["Tables"]["number_quotes"]["Row"];
type Order = Database["public"]["Tables"]["number_orders"]["Row"];
type Profile = Database["public"]["Tables"]["number_provisioning_profiles"]["Row"];
type AvailableNumber = { phoneNumber: string; capabilities: { voice: boolean; sms: boolean }; addressRequirements: string };
type OwnedNumber = { sid: string; accountSid: string; phoneNumber: string; friendlyName: string; capabilities: { voice: boolean; sms: boolean } };
type PurchaseInput = { phoneNumber: string; friendlyName: string; voiceUrl: string; voiceMethod: string; statusCallback: string; statusCallbackMethod: string; bundleSid?: string; addressSid?: string };

export type NumberProvider = {
  available(country: string, phoneNumber?: string): Promise<AvailableNumber[]>;
  price(country: string): Promise<{ monthlyPrice: number; currency: string }>;
  regulations(country: string, endUserType?: "business" | "individual"): Promise<{ sid: string }[]>;
  bundle(sid: string): Promise<{ status: string; regulationSid: string }>;
  address(sid: string): Promise<{ accountSid: string }>;
  voiceApplication(sid: string): Promise<{ voiceUrl: string; voiceMethod: string }>;
  purchase(input: PurchaseInput): Promise<OwnedNumber>;
  owned(phoneNumber: string): Promise<OwnedNumber[]>;
};

export function createNumberProvider(config: AppConfig): NumberProvider {
  // Never automatically retry a paid provisioning POST.
  const client = twilio(config.TWILIO_API_KEY_SID!, config.TWILIO_API_KEY_SECRET!, {
    accountSid: config.TWILIO_ACCOUNT_SID!, autoRetry: false, timeout: 12_000,
  });
  return {
    // Local voice numbers only. SMS/MMS capability is not required for calls.
    available: (country, phoneNumber) => client.availablePhoneNumbers(country).local.list({
      voiceEnabled: true, excludeAllAddressRequired: false, limit: 8,
      ...(phoneNumber ? { contains: phoneNumber } : {}),
    }),
    async price(country) {
      const pricing = await client.pricing.v1.phoneNumbers.countries(country).fetch();
      const rawPrice = pricing.phoneNumberPrices.find((price) => price.numberType?.toLowerCase() === "local")?.currentPrice;
      if (rawPrice === null || rawPrice === undefined || String(rawPrice).trim() === "") throw new Error("Price unavailable");
      const monthlyPrice = Number(rawPrice);
      if (!Number.isFinite(monthlyPrice) || monthlyPrice < 0 || !/^[A-Z]{3}$/i.test(pricing.priceUnit)) throw new Error("Price unavailable");
      return { monthlyPrice, currency: pricing.priceUnit.toUpperCase() };
    },
    regulations: (country, endUserType) => client.numbers.v2.regulatoryCompliance.regulations.list({
      isoCountry: country, numberType: "local", ...(endUserType ? { endUserType } : {}), limit: 100,
    }),
    bundle: (sid) => client.numbers.v2.regulatoryCompliance.bundles(sid).fetch(),
    address: (sid) => client.addresses(sid).fetch(),
    voiceApplication: (sid) => client.applications(sid).fetch(),
    purchase: (input) => client.incomingPhoneNumbers.create(input),
    owned: (phoneNumber) => client.incomingPhoneNumbers.list({ phoneNumber, limit: 20 }),
  };
}

class ProvisioningError extends Error {
  constructor(public code: string, message: string, public status = 503) { super(message); }
}

export function registerNumberRoutes(routes: FastifyInstance, config: AppConfig, db: SupabaseClient<Database> | null, provider: NumberProvider | null) {
  async function authorize(request: FastifyRequest, orgId: string) {
    const context = request.context;
    if (!context) throw new ProvisioningError("unauthorized", "Session requise.", 401);
    if (!uuidSchema.safeParse(orgId).success) throw new ProvisioningError("invalid_request", "Organisation invalide.", 400);
    const admin = await isActiveOrganizationAdmin(context.supabase, context.userId, orgId);
    if (admin.unavailable) throw new ProvisioningError("data_unavailable", "Les droits du compte ne peuvent pas être vérifiés.");
    if (!admin.data) throw new ProvisioningError("purchase_forbidden", "Seul un administrateur peut commander un numéro pour son compte.", 403);
    if (!db || !provider) throw new ProvisioningError("number_setup_required", "La commande de numéros n’est pas encore configurée. Un administrateur doit connecter la téléphonie.");
    const org = await db.from("organizations").select("status").eq("id", orgId).maybeSingle();
    if (org.error) throw new ProvisioningError("data_unavailable", "L’espace ne peut pas être vérifié.");
    if (org.data?.status !== "active") throw new ProvisioningError("purchase_forbidden", "Cet espace est inactif.", 403);
    return context.userId;
  }

  function requireReady() {
    if (config.OPERATIONS_PAUSED) throw new ProvisioningError("operations_paused", config.OPERATIONS_PAUSE_MESSAGE);
    if (!config.VOICE_ENABLED || !config.TWILIO_TWIML_APP_SID || !config.TWILIO_AUTH_TOKEN || !config.API_PUBLIC_URL.startsWith("https://")) {
      throw new ProvisioningError("number_setup_required", "La téléphonie doit être activée par un administrateur avant de commander un numéro.");
    }
  }

  async function profileFor(orgId: string, country: string): Promise<Profile | null> {
    const result = await db!.from("number_provisioning_profiles").select("*").eq("organization_id", orgId).eq("country", country).maybeSingle();
    if (result.error) throw new ProvisioningError("data_unavailable", "Le dossier de votre organisation est indisponible.");
    const profile = result.data;
    const regulations = await provider!.regulations(country, profile?.end_user_type as "business" | "individual" | undefined);
    if (regulations.length) {
      if (!profile?.bundle_sid) throw new ProvisioningError("number_compliance_required", "L’achat d’un numéro local dans ce pays exige un dossier d’identité approuvé par Twilio, même pour les appels uniquement. Faites valider le dossier dans la Console Twilio, puis associez-le à votre organisation avant de commander.", 409);
      const bundle = await provider!.bundle(profile.bundle_sid);
      if (bundle.status !== "twilio-approved") {
        throw new ProvisioningError("number_compliance_required", "Twilio n’a pas encore approuvé le dossier d’identité de votre organisation. Attendez sa validation avant d’acheter un numéro local, même pour les appels uniquement.", 409);
      }
      if (!regulations.some((regulation) => regulation.sid === bundle.regulationSid)) {
        throw new ProvisioningError("number_compliance_required", "Le dossier Twilio associé ne correspond pas aux numéros locaux de ce pays et au type d’utilisateur de votre organisation. Associez un dossier approuvé pour ces numéros locaux.", 409);
      }
    }
    if (profile?.address_sid) {
      const address = await provider!.address(profile.address_sid);
      if (address.accountSid !== config.TWILIO_ACCOUNT_SID) throw new ProvisioningError("number_compliance_required", "L’adresse de votre organisation doit être vérifiée.", 409);
    }
    return profile;
  }

  const present = (order: Order): NumberOrder => ({
    id: order.id, requestKey: order.idempotency_key, status: order.status as NumberOrder["status"], phoneNumber: order.phone_number, lineId: order.line_id,
    message: order.status === "completed" ? "Votre numéro est ajouté à votre compte." : order.status === "failed"
      ? order.failure_message ?? "La commande a été refusée. Recherchez un autre numéro."
      : "Vérification de la commande en cours. Ne commandez pas un autre numéro pour le moment.",
  });

  async function complete(order: Order, number: OwnedNumber): Promise<NumberOrder> {
    if (number.phoneNumber !== order.phone_number || number.accountSid !== order.account_sid || number.friendlyName !== `onoff-order:${order.id}` || !/^PN[0-9a-fA-F]{32}$/.test(number.sid) || !number.capabilities.voice) return present(order);
    const result = await db!.rpc("complete_number_order", {
      p_order_id: order.id, p_account_sid: number.accountSid, p_number_sid: number.sid,
      // Product permissions stay voice-only even if Twilio also supports SMS.
      p_phone_number: number.phoneNumber, p_voice: number.capabilities.voice, p_sms: false,
    });
    if (result.error || !result.data) return present(order);
    return present({ ...order, status: "completed", line_id: result.data });
  }

  async function reconcile(order: Order): Promise<NumberOrder> {
    if (order.status !== "pending" || order.account_sid !== config.TWILIO_ACCOUNT_SID) return present(order);
    try {
      const numbers = await provider!.owned(order.phone_number);
      const purchased = numbers.find((number) => number.phoneNumber === order.phone_number && number.friendlyName === `onoff-order:${order.id}`);
      return purchased ? await complete(order, purchased) : present(order);
    } catch { return present(order); }
  }

  function fail(error: unknown, request: FastifyRequest, reply: FastifyReply) {
    const known = error instanceof ProvisioningError;
    request.log.warn({ requestId: request.id, code: known ? error.code : "number_provider_unavailable" }, "number provisioning request failed");
    return reply.code(known ? error.status : 503).send({
      code: known ? error.code : "number_provider_unavailable",
      message: known ? error.message : "Le service de numéros est momentanément indisponible. Réessayez dans un instant.", requestId: request.id,
    });
  }

  routes.get<{ Params: { orgId: string }; Querystring: { country?: string } }>("/v1/organizations/:orgId/number-offers", async (request, reply) => {
    reply.header("cache-control", "no-store");
    try {
      const userId = await authorize(request, request.params.orgId);
      requireReady();
      const parsed = numberCountrySchema.safeParse(request.query.country);
      if (!parsed.success) throw new ProvisioningError("invalid_country", "Choisissez un pays proposé.", 400);
      const country = parsed.data;
      const profile = await profileFor(request.params.orgId, country);
      const [available, price] = await Promise.all([provider!.available(country), provider!.price(country)]);
      const voiceNumbers = available.filter((number) => number.capabilities.voice);
      const candidates = voiceNumbers.filter((number) => number.addressRequirements === "none" || profile?.address_sid);
      if (voiceNumbers.length && !candidates.length) throw new ProvisioningError("number_address_required", "Une adresse validée doit être associée à votre organisation pour commander ces numéros locaux.", 409);
      const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
      const quotes = candidates.map((number) => ({
        id: randomUUID(), organization_id: request.params.orgId, user_id: userId, country,
        phone_number: number.phoneNumber, account_sid: config.TWILIO_ACCOUNT_SID!, monthly_price: price.monthlyPrice,
        currency: price.currency, sms_enabled: false, bundle_sid: profile?.bundle_sid ?? null,
        address_sid: profile?.address_sid ?? null, expires_at: expiresAt,
      }));
      if (quotes.length) {
        const stored = await db!.from("number_quotes").insert(quotes);
        if (stored.error) throw new ProvisioningError("data_unavailable", "La sélection de numéros ne peut pas être enregistrée.");
      }
      return { items: quotes.map((quote) => ({
        quoteId: quote.id, phoneNumber: quote.phone_number, monthlyPrice: quote.monthly_price,
        currency: quote.currency, smsEnabled: quote.sms_enabled, expiresAt: quote.expires_at,
      })) };
    } catch (error) { return fail(error, request, reply); }
  });

  routes.get<{ Params: { orgId: string } }>("/v1/organizations/:orgId/number-orders", async (request, reply) => {
    reply.header("cache-control", "no-store");
    try {
      const userId = await authorize(request, request.params.orgId);
      const result = await db!.from("number_orders").select("*").eq("organization_id", request.params.orgId).eq("user_id", userId).order("created_at", { ascending: false }).limit(10);
      if (result.error) throw new ProvisioningError("data_unavailable", "Les commandes ne peuvent pas être vérifiées. Réessayez avant tout nouvel achat.");
      return { items: await Promise.all((result.data ?? []).map(reconcile)) };
    } catch (error) { return fail(error, request, reply); }
  });

  routes.post<{ Params: { orgId: string } }>("/v1/organizations/:orgId/number-orders", async (request, reply) => {
    reply.header("cache-control", "no-store");
    try {
      const userId = await authorize(request, request.params.orgId);
      const body = numberPurchaseSchema.safeParse(request.body);
      const key = uuidSchema.safeParse(request.headers["idempotency-key"]);
      if (!body.success || !key.success) throw new ProvisioningError("invalid_purchase", "La demande de commande est invalide.", 400);
      // Recover first, even after a quote expires or purchases are paused.
      const previous = await db!.from("number_orders").select("*").eq("organization_id", request.params.orgId).eq("user_id", userId).eq("idempotency_key", key.data).maybeSingle();
      if (previous.error) throw new ProvisioningError("data_unavailable", "La commande ne peut pas être vérifiée.");
      if (previous.data) {
        if (previous.data.quote_id !== body.data.quoteId) throw new ProvisioningError("idempotency_conflict", "Cette demande correspond à une autre commande.", 409);
        return await reconcile(previous.data);
      }
      requireReady();
      const quoted = await db!.from("number_quotes").select("*").eq("id", body.data.quoteId).eq("organization_id", request.params.orgId).eq("user_id", userId).maybeSingle();
      if (quoted.error) throw new ProvisioningError("data_unavailable", "La sélection ne peut pas être vérifiée.");
      const quote: Quote | null = quoted.data;
      if (!quote || Date.parse(quote.expires_at) <= Date.now() || quote.account_sid !== config.TWILIO_ACCOUNT_SID) throw new ProvisioningError("quote_expired", "Cette sélection a expiré. Recherchez à nouveau les numéros disponibles.", 409);
      const [profile, price, application] = await Promise.all([
        profileFor(request.params.orgId, quote.country), provider!.price(quote.country), provider!.voiceApplication(config.TWILIO_TWIML_APP_SID!),
      ]);
      const base = config.API_PUBLIC_URL.replace(/\/$/, "");
      if (application.voiceUrl !== `${base}/webhooks/twilio/voice/outbound` || application.voiceMethod !== "POST") throw new ProvisioningError("number_setup_required", "La configuration des appels doit être terminée avant l’achat.");
      if (price.monthlyPrice !== Number(quote.monthly_price) || price.currency !== quote.currency) throw new ProvisioningError("price_changed", "Le tarif a changé. Recherchez à nouveau pour confirmer le nouveau prix.", 409);
      if ((profile?.bundle_sid ?? null) !== quote.bundle_sid || (profile?.address_sid ?? null) !== quote.address_sid) throw new ProvisioningError("quote_expired", "Le dossier de votre organisation a changé. Relancez la recherche.", 409);
      const available = await provider!.available(quote.country, quote.phone_number);
      const chosen = available.find((number) => number.phoneNumber === quote.phone_number && number.capabilities.voice && (number.addressRequirements === "none" || quote.address_sid));
      if (!chosen) throw new ProvisioningError("number_unavailable", "Ce numéro n’est plus disponible. Choisissez-en un autre.", 409);
      const started = await db!.rpc("begin_number_order", { p_org_id: request.params.orgId, p_user_id: userId, p_quote_id: quote.id, p_key: key.data });
      if (started.error || !started.data) throw new ProvisioningError("order_not_started", started.error?.code === "23505" ? "Une commande existe déjà. Vérifiez son état avant de continuer." : "La commande n’a pas démarré. Actualisez la sélection et réessayez.", 409);
      const { created, order } = started.data as unknown as { created: boolean; order: Order };
      if (!created) return await reconcile(order);
      // Only the request that persisted this order may submit the paid POST, once.
      // Any later request only reconciles the tagged Twilio resource.
      let number: OwnedNumber;
      try {
        number = await provider!.purchase({
          phoneNumber: order.phone_number, friendlyName: `onoff-order:${order.id}`,
          voiceUrl: `${base}/webhooks/twilio/voice/inbound`, voiceMethod: "POST",
          statusCallback: `${base}/webhooks/twilio/voice/status`, statusCallbackMethod: "POST",
          ...(quote.bundle_sid ? { bundleSid: quote.bundle_sid } : {}), ...(quote.address_sid ? { addressSid: quote.address_sid } : {}),
        });
      } catch (error) {
        const status = error && typeof error === "object" && "status" in error ? Number(error.status) : 0;
        if (status >= 400 && status < 500 && status !== 408) {
          const message = "Twilio a refusé la commande. Vérifiez le solde et le dossier d’identité, puis recherchez à nouveau un numéro.";
          const saved = await db!.from("number_orders").update({ status: "failed", failure_message: message, updated_at: new Date().toISOString() }).eq("id", order.id).eq("status", "pending");
          if (!saved.error) return present({ ...order, status: "failed", failure_message: message });
        }
        return reply.code(202).send(await reconcile(order));
      }
      const result = await complete(order, number);
      return reply.code(result.status === "completed" ? 201 : 202).send(result);
    } catch (error) { return fail(error, request, reply); }
  });
}
