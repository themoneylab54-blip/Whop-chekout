import type { Lang } from "./i18n-core";

/*
 * The block defaults that are example content (a heading, a text, a testimonial, an announcement, two
 * reviews, three key figures), in every checkout language: part of the block defaults (localize's
 * DEFAULT_TEXTS spreads them in), and apart from them for legacy-sample, which recognises example
 * content on the buyer's page without downloading every block default. Pure.
 */

export const SAMPLE_DEFAULTS = {
  fr: {
    textHeading: "Titre",
    textBody: "Votre texte ici.",
    testimonialQuote: "Livraison rapide et produit conforme, je recommande.",
    announcement: "Livraison offerte dès 50 € d'achat",
    review1: "Commande reçue en 3 jours, qualité au top. Je recommande !",
    review2: "Service client réactif et produit conforme aux photos.",
    statCustomersValue: "+10 000",
    statRatingValue: "4,8/5",
    statDispatch: "expédition",
  },
  en: {
    textHeading: "Title",
    textBody: "Your text here.",
    testimonialQuote: "Fast delivery and the product is exactly as described. I recommend it.",
    announcement: "Free shipping on orders over €50",
    review1: "Order received in 3 days, top quality. I recommend it!",
    review2: "Responsive customer service and the product matches the photos.",
    statCustomersValue: "10,000+",
    statRatingValue: "4.8/5",
    statDispatch: "dispatch",
  },
  de: {
    textHeading: "Titel",
    textBody: "Ihr Text hier.",
    testimonialQuote: "Schnelle Lieferung und Produkt wie beschrieben. Sehr empfehlenswert.",
    announcement: "Kostenloser Versand ab 50 € Bestellwert",
    review1: "Bestellung in 3 Tagen erhalten, top Qualität. Sehr empfehlenswert!",
    review2: "Reaktionsschneller Kundenservice und das Produkt entspricht den Fotos.",
    statCustomersValue: "10.000+",
    statRatingValue: "4,8/5",
    statDispatch: "Versand",
  },
  es: {
    textHeading: "Título",
    textBody: "Tu texto aquí.",
    testimonialQuote: "Envío rápido y producto tal como se describe. Lo recomiendo.",
    announcement: "Envío gratis a partir de 50 € de compra",
    review1: "Pedido recibido en 3 días, calidad excelente. ¡Lo recomiendo!",
    review2: "Atención al cliente rápida y producto igual que en las fotos.",
    statCustomersValue: "+10.000",
    statRatingValue: "4,8/5",
    statDispatch: "envío",
  },
  it: {
    textHeading: "Titolo",
    textBody: "Il tuo testo qui.",
    testimonialQuote: "Consegna rapida e prodotto conforme alla descrizione. Lo consiglio.",
    announcement: "Spedizione gratuita da 50 € di spesa",
    review1: "Ordine ricevuto in 3 giorni, qualità top. Lo consiglio!",
    review2: "Servizio clienti reattivo e prodotto conforme alle foto.",
    statCustomersValue: "+10.000",
    statRatingValue: "4,8/5",
    statDispatch: "spedizione",
  },
  nl: {
    textHeading: "Titel",
    textBody: "Je tekst hier.",
    testimonialQuote: "Snelle levering en het product klopt precies. Een aanrader.",
    announcement: "Gratis verzending vanaf € 50",
    review1: "Bestelling binnen 3 dagen ontvangen, topkwaliteit. Een aanrader!",
    review2: "Snelle klantenservice en het product is zoals op de foto's.",
    statCustomersValue: "10.000+",
    statRatingValue: "4,8/5",
    statDispatch: "verzending",
  },
} as const satisfies Record<Lang, Record<string, string>>;

export type SampleKey = keyof (typeof SAMPLE_DEFAULTS)["fr"];
