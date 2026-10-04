import type { Block, Layout, Theme } from "@/lib/layout";
import { LABELS, type Lang } from "./i18n";

/**
 * Buyer-language text of the checkout / thank-you blocks.
 *
 * Blocks are created with French copy (DEFAULT_PROPS in lib/layout.ts). At render time:
 *   1. a merchant translation for the buyer's language (`block.i18n[lang][path]`) wins;
 *   2. else a text still equal to a shipped French default shows its translation;
 *   3. else the merchant's own text, as typed.
 * Pure (server and browser): no React, no DB.
 */

/** Shipped French copy of the block defaults, and its translation in every checkout language. */
export const DEFAULT_TEXTS = {
  fr: {
    securePayment: "Paiement sécurisé",
    encryptedData: "Données chiffrées",
    orderTracking: "Suivi de commande",
    textHeading: "Titre",
    textBody: "Votre texte ici.",
    testimonialQuote: "Livraison rapide et produit conforme, je recommande.",
    testimonialAuthor: "Client vérifié",
    ratingLabel: "note moyenne de nos clients",
    moneyBack30: "Satisfait ou remboursé 30 jours",
    easyReturns: "Retours faciles",
    moneyBack: "Satisfait ou remboursé",
    guaranteeText: "Pas satisfait ? Retournez le produit sous 30 jours et on vous rembourse.",
    faqQ1: "Quand vais-je recevoir ma commande ?",
    faqA1: "Les commandes partent sous 24 à 48 h ouvrées.",
    faqQ2: "Puis-je retourner mon produit ?",
    faqA2: "Oui, vous avez 30 jours pour changer d'avis.",
    freeShipping: "Livraison offerte",
    paymentMethods: "Moyens de paiement acceptés",
    announcement: "Livraison offerte dès 50 € d'achat",
    countdown: "L'offre se termine dans :",
    lowStock: "Plus que {n} en stock",
    whyUs: "Pourquoi nous ?",
    guarantee30: "Garantie 30 jours",
    refundedIfUnhappy: "Remboursé si vous n'êtes pas satisfait.",
    fastDispatch: "Expédition rapide",
    dispatched48: "Préparée et expédiée sous 48 h.",
    encrypted: "Transactions chiffrées de bout en bout.",
    freeShippingBar: "Plus que {amount} pour profiter de la livraison offerte",
    freeShippingDone: "Bravo, la livraison est offerte !",
    reviewsTitle: "Ce que disent nos clients",
    review1: "Commande reçue en 3 jours, qualité au top. Je recommande !",
    review2: "Service client réactif et produit conforme aux photos.",
    comparisonTitle: "Pourquoi nous choisir",
    us: "Nous",
    them: "Les autres",
    support7: "Service client 7j/7",
    logosTitle: "Ils parlent de nous",
    statCustomersValue: "+10 000",
    statCustomers: "clients satisfaits",
    statRatingValue: "4,8/5",
    statRating: "note moyenne",
    statDispatch: "expédition",
    fastDelivery: "Livraison rapide",
    shipped48: "Expédiée sous 48 h",
    support7Short: "Support 7j/7",
    realTeam: "Une vraie équipe à l'écoute",
    secureBadge: "Paiement 100 % sécurisé",
    secureBadgeSub: "Vos données sont chiffrées et ne sont jamais stockées.",
    orderNoteTitle: "Une précision sur votre commande ?",
    orderNotePlaceholder: "Instructions de livraison, message cadeau…",
    supportText: "Notre équipe vous répond en moins de 24 h.",
    couponTitle: "Merci ! Voici un cadeau",
    couponText: "Profitez de -10 % sur votre prochaine commande.",
    socialTitle: "Suivez-nous",
    upsellBadge: "Offre réservée à votre commande",
    upsellTitle: "Ajoutez-le à votre colis",
    upsellText: "Expédié avec votre commande, sans frais de livraison supplémentaires. Un clic, sans ressaisir votre carte.",
    upsellYes: "Oui, ajouter à ma commande",
    upsellNo: "Non merci",
    protectionClaim:
      "Colis perdu, volé ou abîmé ? Écrivez-nous dans les 14 jours suivant la livraison prévue avec votre numéro de commande (et une photo en cas de casse) : nous le renvoyons ou vous remboursons.",
    vatIncluded: "TVA incluse",
    messageTitle: "Un mot de notre équipe",
    messageBody:
      "Votre commande compte énormément pour nous. Chaque colis est préparé avec **le plus grand soin**, et nous avons hâte que vous le découvriez.\n\nMerci de votre confiance, à très vite !",
    messageRole: "L'équipe",
  },
  en: {
    securePayment: "Secure payment",
    encryptedData: "Encrypted data",
    orderTracking: "Order tracking",
    textHeading: "Title",
    textBody: "Your text here.",
    testimonialQuote: "Fast delivery and the product is exactly as described. I recommend it.",
    testimonialAuthor: "Verified customer",
    ratingLabel: "average rating from our customers",
    moneyBack30: "30-day money-back guarantee",
    easyReturns: "Easy returns",
    moneyBack: "Money-back guarantee",
    guaranteeText: "Not satisfied? Return the product within 30 days and we'll refund you.",
    faqQ1: "When will I receive my order?",
    faqA1: "Orders ship within 24 to 48 business hours.",
    faqQ2: "Can I return my product?",
    faqA2: "Yes, you have 30 days to change your mind.",
    freeShipping: "Free shipping",
    paymentMethods: "Accepted payment methods",
    announcement: "Free shipping on orders over €50",
    countdown: "Offer ends in:",
    lowStock: "Only {n} left in stock",
    whyUs: "Why us?",
    guarantee30: "30-day guarantee",
    refundedIfUnhappy: "Refunded if you're not satisfied.",
    fastDispatch: "Fast dispatch",
    dispatched48: "Packed and shipped within 48 h.",
    encrypted: "End-to-end encrypted transactions.",
    freeShippingBar: "Only {amount} more for free shipping",
    freeShippingDone: "Congrats, shipping is free!",
    reviewsTitle: "What our customers say",
    review1: "Order received in 3 days, top quality. I recommend it!",
    review2: "Responsive customer service and the product matches the photos.",
    comparisonTitle: "Why choose us",
    us: "Us",
    them: "Others",
    support7: "Customer service 7 days a week",
    logosTitle: "As seen in",
    statCustomersValue: "10,000+",
    statCustomers: "happy customers",
    statRatingValue: "4.8/5",
    statRating: "average rating",
    statDispatch: "dispatch",
    fastDelivery: "Fast delivery",
    shipped48: "Shipped within 48 h",
    support7Short: "Support 7 days a week",
    realTeam: "A real team, here to help",
    secureBadge: "100% secure payment",
    secureBadgeSub: "Your data is encrypted and never stored.",
    orderNoteTitle: "Anything to add to your order?",
    orderNotePlaceholder: "Delivery instructions, gift message…",
    supportText: "Our team replies in less than 24 h.",
    couponTitle: "Thank you! Here's a gift",
    couponText: "Enjoy 10% off your next order.",
    socialTitle: "Follow us",
    upsellBadge: "Exclusive offer for your order",
    upsellTitle: "Add it to your parcel",
    upsellText: "Shipped with your order at no extra shipping cost. One click, no need to re-enter your card.",
    upsellYes: "Yes, add to my order",
    upsellNo: "No thanks",
    protectionClaim:
      "Parcel lost, stolen or damaged? Write to us within 14 days of the expected delivery date with your order number (and a photo if it's broken): we'll reship it or refund you.",
    vatIncluded: "VAT included",
    messageTitle: "A word from our team",
    messageBody:
      "Your order means a lot to us. Every parcel is packed with **the greatest care**, and we can't wait for you to discover it.\n\nThank you for your trust, see you soon!",
    messageRole: "The team",
  },
  de: {
    securePayment: "Sichere Zahlung",
    encryptedData: "Verschlüsselte Daten",
    orderTracking: "Sendungsverfolgung",
    textHeading: "Titel",
    textBody: "Ihr Text hier.",
    testimonialQuote: "Schnelle Lieferung und Produkt wie beschrieben. Sehr empfehlenswert.",
    testimonialAuthor: "Verifizierter Kunde",
    ratingLabel: "Durchschnittsbewertung unserer Kunden",
    moneyBack30: "30 Tage Geld-zurück-Garantie",
    easyReturns: "Einfache Rücksendung",
    moneyBack: "Geld-zurück-Garantie",
    guaranteeText: "Nicht zufrieden? Senden Sie das Produkt innerhalb von 30 Tagen zurück und Sie erhalten Ihr Geld zurück.",
    faqQ1: "Wann erhalte ich meine Bestellung?",
    faqA1: "Bestellungen werden innerhalb von 24 bis 48 Werkstunden versendet.",
    faqQ2: "Kann ich mein Produkt zurücksenden?",
    faqA2: "Ja, Sie haben 30 Tage Bedenkzeit.",
    freeShipping: "Kostenloser Versand",
    paymentMethods: "Akzeptierte Zahlungsarten",
    announcement: "Kostenloser Versand ab 50 € Bestellwert",
    countdown: "Das Angebot endet in:",
    lowStock: "Nur noch {n} auf Lager",
    whyUs: "Warum wir?",
    guarantee30: "30 Tage Garantie",
    refundedIfUnhappy: "Geld zurück, wenn Sie nicht zufrieden sind.",
    fastDispatch: "Schneller Versand",
    dispatched48: "Verpackt und versendet innerhalb von 48 Std.",
    encrypted: "Durchgehend verschlüsselte Transaktionen.",
    freeShippingBar: "Nur noch {amount} bis zum kostenlosen Versand",
    freeShippingDone: "Glückwunsch, der Versand ist kostenlos!",
    reviewsTitle: "Das sagen unsere Kunden",
    review1: "Bestellung in 3 Tagen erhalten, top Qualität. Sehr empfehlenswert!",
    review2: "Reaktionsschneller Kundenservice und das Produkt entspricht den Fotos.",
    comparisonTitle: "Warum Sie uns wählen sollten",
    us: "Wir",
    them: "Andere",
    support7: "Kundenservice 7 Tage die Woche",
    logosTitle: "Bekannt aus",
    statCustomersValue: "10.000+",
    statCustomers: "zufriedene Kunden",
    statRatingValue: "4,8/5",
    statRating: "Durchschnittsbewertung",
    statDispatch: "Versand",
    fastDelivery: "Schnelle Lieferung",
    shipped48: "Versand innerhalb von 48 Std.",
    support7Short: "Support 7 Tage die Woche",
    realTeam: "Ein echtes Team für Sie da",
    secureBadge: "100 % sichere Zahlung",
    secureBadgeSub: "Ihre Daten werden verschlüsselt und niemals gespeichert.",
    orderNoteTitle: "Noch etwas zu Ihrer Bestellung?",
    orderNotePlaceholder: "Lieferhinweise, Geschenknachricht…",
    supportText: "Unser Team antwortet in weniger als 24 Std.",
    couponTitle: "Danke! Hier ist ein Geschenk",
    couponText: "Sparen Sie 10 % bei Ihrer nächsten Bestellung.",
    socialTitle: "Folgen Sie uns",
    upsellBadge: "Exklusives Angebot zu Ihrer Bestellung",
    upsellTitle: "Legen Sie es mit ins Paket",
    upsellText: "Wird mit Ihrer Bestellung ohne zusätzliche Versandkosten verschickt. Ein Klick, ohne erneute Karteneingabe.",
    upsellYes: "Ja, zur Bestellung hinzufügen",
    upsellNo: "Nein danke",
    protectionClaim:
      "Paket verloren, gestohlen oder beschädigt? Schreiben Sie uns innerhalb von 14 Tagen nach dem geplanten Liefertermin mit Ihrer Bestellnummer (und bei Bruch einem Foto): Wir senden es erneut oder erstatten Ihnen den Betrag.",
    vatIncluded: "inkl. MwSt.",
    messageTitle: "Ein paar Worte von unserem Team",
    messageBody:
      "Ihre Bestellung bedeutet uns sehr viel. Jedes Paket wird mit **größter Sorgfalt** gepackt, und wir freuen uns schon darauf, dass Sie es entdecken.\n\nDanke für Ihr Vertrauen, bis bald!",
    messageRole: "Das Team",
  },
  es: {
    securePayment: "Pago seguro",
    encryptedData: "Datos cifrados",
    orderTracking: "Seguimiento del pedido",
    textHeading: "Título",
    textBody: "Tu texto aquí.",
    testimonialQuote: "Envío rápido y producto tal como se describe. Lo recomiendo.",
    testimonialAuthor: "Cliente verificado",
    ratingLabel: "valoración media de nuestros clientes",
    moneyBack30: "Satisfecho o reembolsado 30 días",
    easyReturns: "Devoluciones fáciles",
    moneyBack: "Satisfecho o reembolsado",
    guaranteeText: "¿No estás satisfecho? Devuelve el producto en un plazo de 30 días y te reembolsamos.",
    faqQ1: "¿Cuándo recibiré mi pedido?",
    faqA1: "Los pedidos salen en un plazo de 24 a 48 h laborables.",
    faqQ2: "¿Puedo devolver mi producto?",
    faqA2: "Sí, tienes 30 días para cambiar de opinión.",
    freeShipping: "Envío gratis",
    paymentMethods: "Métodos de pago aceptados",
    announcement: "Envío gratis a partir de 50 € de compra",
    countdown: "La oferta termina en:",
    lowStock: "Solo quedan {n} en stock",
    whyUs: "¿Por qué nosotros?",
    guarantee30: "Garantía de 30 días",
    refundedIfUnhappy: "Te reembolsamos si no estás satisfecho.",
    fastDispatch: "Envío rápido",
    dispatched48: "Preparado y enviado en 48 h.",
    encrypted: "Transacciones cifradas de extremo a extremo.",
    freeShippingBar: "Solo te faltan {amount} para el envío gratis",
    freeShippingDone: "¡Enhorabuena, el envío es gratis!",
    reviewsTitle: "Lo que dicen nuestros clientes",
    review1: "Pedido recibido en 3 días, calidad excelente. ¡Lo recomiendo!",
    review2: "Atención al cliente rápida y producto igual que en las fotos.",
    comparisonTitle: "Por qué elegirnos",
    us: "Nosotros",
    them: "Los demás",
    support7: "Atención al cliente 7 días a la semana",
    logosTitle: "Hablan de nosotros",
    statCustomersValue: "+10.000",
    statCustomers: "clientes satisfechos",
    statRatingValue: "4,8/5",
    statRating: "valoración media",
    statDispatch: "envío",
    fastDelivery: "Entrega rápida",
    shipped48: "Enviado en 48 h",
    support7Short: "Soporte 7 días a la semana",
    realTeam: "Un equipo real a tu disposición",
    secureBadge: "Pago 100 % seguro",
    secureBadgeSub: "Tus datos están cifrados y nunca se almacenan.",
    orderNoteTitle: "¿Algún detalle sobre tu pedido?",
    orderNotePlaceholder: "Instrucciones de entrega, mensaje de regalo…",
    supportText: "Nuestro equipo te responde en menos de 24 h.",
    couponTitle: "¡Gracias! Aquí tienes un regalo",
    couponText: "Disfruta de un 10 % de descuento en tu próximo pedido.",
    socialTitle: "Síguenos",
    upsellBadge: "Oferta exclusiva para tu pedido",
    upsellTitle: "Añádelo a tu paquete",
    upsellText: "Se envía con tu pedido, sin gastos de envío adicionales. Un clic, sin volver a introducir tu tarjeta.",
    upsellYes: "Sí, añadir a mi pedido",
    upsellNo: "No, gracias",
    protectionClaim:
      "¿Paquete perdido, robado o dañado? Escríbenos en los 14 días siguientes a la fecha de entrega prevista con tu número de pedido (y una foto si está roto): te lo reenviamos o te lo reembolsamos.",
    vatIncluded: "IVA incluido",
    messageTitle: "Unas palabras de nuestro equipo",
    messageBody:
      "Tu pedido significa mucho para nosotros. Cada paquete se prepara con **el mayor cuidado**, y estamos deseando que lo descubras.\n\nGracias por tu confianza, ¡hasta pronto!",
    messageRole: "El equipo",
  },
  it: {
    securePayment: "Pagamento sicuro",
    encryptedData: "Dati crittografati",
    orderTracking: "Tracciamento dell'ordine",
    textHeading: "Titolo",
    textBody: "Il tuo testo qui.",
    testimonialQuote: "Consegna rapida e prodotto conforme alla descrizione. Lo consiglio.",
    testimonialAuthor: "Cliente verificato",
    ratingLabel: "valutazione media dei nostri clienti",
    moneyBack30: "Soddisfatti o rimborsati 30 giorni",
    easyReturns: "Resi facili",
    moneyBack: "Soddisfatti o rimborsati",
    guaranteeText: "Non sei soddisfatto? Restituisci il prodotto entro 30 giorni e ti rimborsiamo.",
    faqQ1: "Quando riceverò il mio ordine?",
    faqA1: "Gli ordini partono entro 24-48 ore lavorative.",
    faqQ2: "Posso restituire il prodotto?",
    faqA2: "Sì, hai 30 giorni per cambiare idea.",
    freeShipping: "Spedizione gratuita",
    paymentMethods: "Metodi di pagamento accettati",
    announcement: "Spedizione gratuita da 50 € di spesa",
    countdown: "L'offerta termina tra:",
    lowStock: "Solo {n} rimasti in magazzino",
    whyUs: "Perché noi?",
    guarantee30: "Garanzia 30 giorni",
    refundedIfUnhappy: "Rimborsato se non sei soddisfatto.",
    fastDispatch: "Spedizione rapida",
    dispatched48: "Preparato e spedito entro 48 ore.",
    encrypted: "Transazioni crittografate end-to-end.",
    freeShippingBar: "Ancora {amount} per la spedizione gratuita",
    freeShippingDone: "Complimenti, la spedizione è gratuita!",
    reviewsTitle: "Cosa dicono i nostri clienti",
    review1: "Ordine ricevuto in 3 giorni, qualità top. Lo consiglio!",
    review2: "Servizio clienti reattivo e prodotto conforme alle foto.",
    comparisonTitle: "Perché sceglierci",
    us: "Noi",
    them: "Gli altri",
    support7: "Servizio clienti 7 giorni su 7",
    logosTitle: "Parlano di noi",
    statCustomersValue: "+10.000",
    statCustomers: "clienti soddisfatti",
    statRatingValue: "4,8/5",
    statRating: "valutazione media",
    statDispatch: "spedizione",
    fastDelivery: "Consegna rapida",
    shipped48: "Spedito entro 48 ore",
    support7Short: "Assistenza 7 giorni su 7",
    realTeam: "Un vero team al tuo ascolto",
    secureBadge: "Pagamento sicuro al 100%",
    secureBadgeSub: "I tuoi dati sono crittografati e mai memorizzati.",
    orderNoteTitle: "Una precisazione sul tuo ordine?",
    orderNotePlaceholder: "Istruzioni di consegna, messaggio regalo…",
    supportText: "Il nostro team risponde in meno di 24 ore.",
    couponTitle: "Grazie! Ecco un regalo",
    couponText: "Approfitta del 10% di sconto sul tuo prossimo ordine.",
    socialTitle: "Seguici",
    upsellBadge: "Offerta riservata al tuo ordine",
    upsellTitle: "Aggiungilo al tuo pacco",
    upsellText: "Spedito con il tuo ordine, senza costi di spedizione aggiuntivi. Un clic, senza reinserire la carta.",
    upsellYes: "Sì, aggiungi al mio ordine",
    upsellNo: "No, grazie",
    protectionClaim:
      "Pacco smarrito, rubato o danneggiato? Scrivici entro 14 giorni dalla data di consegna prevista con il numero d'ordine (e una foto in caso di rottura): lo rispediamo o ti rimborsiamo.",
    vatIncluded: "IVA inclusa",
    messageTitle: "Due parole dal nostro team",
    messageBody:
      "Il tuo ordine per noi conta tantissimo. Ogni pacco viene preparato con **la massima cura**, e non vediamo l'ora che tu lo scopra.\n\nGrazie per la fiducia, a presto!",
    messageRole: "Il team",
  },
  nl: {
    securePayment: "Veilig betalen",
    encryptedData: "Versleutelde gegevens",
    orderTracking: "Bestelling volgen",
    textHeading: "Titel",
    textBody: "Je tekst hier.",
    testimonialQuote: "Snelle levering en het product klopt precies. Een aanrader.",
    testimonialAuthor: "Geverifieerde klant",
    ratingLabel: "gemiddelde beoordeling van onze klanten",
    moneyBack30: "30 dagen niet goed, geld terug",
    easyReturns: "Eenvoudig retourneren",
    moneyBack: "Niet goed, geld terug",
    guaranteeText: "Niet tevreden? Stuur het product binnen 30 dagen terug en je krijgt je geld terug.",
    faqQ1: "Wanneer ontvang ik mijn bestelling?",
    faqA1: "Bestellingen worden binnen 24 tot 48 werkuren verzonden.",
    faqQ2: "Kan ik mijn product retourneren?",
    faqA2: "Ja, je hebt 30 dagen bedenktijd.",
    freeShipping: "Gratis verzending",
    paymentMethods: "Geaccepteerde betaalmethoden",
    announcement: "Gratis verzending vanaf € 50",
    countdown: "De aanbieding eindigt over:",
    lowStock: "Nog maar {n} op voorraad",
    whyUs: "Waarom wij?",
    guarantee30: "30 dagen garantie",
    refundedIfUnhappy: "Geld terug als je niet tevreden bent.",
    fastDispatch: "Snelle verzending",
    dispatched48: "Ingepakt en verzonden binnen 48 uur.",
    encrypted: "End-to-end versleutelde transacties.",
    freeShippingBar: "Nog {amount} tot gratis verzending",
    freeShippingDone: "Gefeliciteerd, de verzending is gratis!",
    reviewsTitle: "Wat onze klanten zeggen",
    review1: "Bestelling binnen 3 dagen ontvangen, topkwaliteit. Een aanrader!",
    review2: "Snelle klantenservice en het product is zoals op de foto's.",
    comparisonTitle: "Waarom voor ons kiezen",
    us: "Wij",
    them: "Anderen",
    support7: "Klantenservice 7 dagen per week",
    logosTitle: "Bekend van",
    statCustomersValue: "10.000+",
    statCustomers: "tevreden klanten",
    statRatingValue: "4,8/5",
    statRating: "gemiddelde beoordeling",
    statDispatch: "verzending",
    fastDelivery: "Snelle levering",
    shipped48: "Verzonden binnen 48 uur",
    support7Short: "Support 7 dagen per week",
    realTeam: "Een echt team dat voor je klaarstaat",
    secureBadge: "100% veilig betalen",
    secureBadgeSub: "Je gegevens worden versleuteld en nooit opgeslagen.",
    orderNoteTitle: "Nog iets over je bestelling?",
    orderNotePlaceholder: "Bezorginstructies, cadeaubericht…",
    supportText: "Ons team antwoordt binnen 24 uur.",
    couponTitle: "Bedankt! Hier is een cadeau",
    couponText: "Geniet van 10% korting op je volgende bestelling.",
    socialTitle: "Volg ons",
    upsellBadge: "Exclusief aanbod bij je bestelling",
    upsellTitle: "Voeg het toe aan je pakket",
    upsellText: "Verzonden met je bestelling, zonder extra verzendkosten. Eén klik, zonder je kaart opnieuw in te voeren.",
    upsellYes: "Ja, toevoegen aan mijn bestelling",
    upsellNo: "Nee, bedankt",
    protectionClaim:
      "Pakket kwijt, gestolen of beschadigd? Schrijf ons binnen 14 dagen na de verwachte leverdatum met je bestelnummer (en een foto bij breuk): we sturen het opnieuw of betalen je terug.",
    vatIncluded: "incl. btw",
    messageTitle: "Een woordje van ons team",
    messageBody:
      "Je bestelling betekent veel voor ons. Elk pakket wordt met **de grootste zorg** ingepakt, en we kunnen niet wachten tot je het ontdekt.\n\nBedankt voor je vertrouwen, tot snel!",
    messageRole: "Het team",
  },
} as const satisfies Record<Lang, Record<string, string>>;

export type DefaultTextKey = keyof (typeof DEFAULT_TEXTS)["fr"];

/** Checkout labels a merchant may also have typed as-is (builder placeholders, section titles). */
const LINKED_LABELS = [
  "contact",
  "delivery",
  "shippingAddress",
  "shippingMethod",
  "payment",
  "addons",
  "summary",
  "shipTo",
  "expressCheckout",
  "or",
  "continueShopping",
  "needHelp",
  "estimatedDelivery",
  "recoTitle",
  "protectionTitle",
  "protectionText",
  "surveyQuestion",
] as const satisfies readonly (keyof (typeof LABELS)["fr"])[];

type Source = { kind: "default"; key: DefaultTextKey } | { kind: "label"; key: (typeof LINKED_LABELS)[number] };

/** French text (trimmed) → where its translations live. */
const FRENCH_SOURCES: ReadonlyMap<string, Source> = (() => {
  const map = new Map<string, Source>();
  for (const [key, value] of Object.entries(DEFAULT_TEXTS.fr)) map.set(value, { kind: "default", key: key as DefaultTextKey });
  for (const key of LINKED_LABELS) {
    const value = LABELS.fr[key];
    if (!map.has(value)) map.set(value, { kind: "label", key });
  }
  return map;
})();

/**
 * The buyer-language version of a shipped French default ("Paiement sécurisé" → "Secure
 * payment"); any other text comes back unchanged.
 */
export function translateDefault(text: string, lang: Lang): string {
  if (lang === "fr" || !text) return text;
  const source = FRENCH_SOURCES.get(text.trim());
  if (!source) return text;
  return source.kind === "default" ? DEFAULT_TEXTS[lang][source.key] : LABELS[lang][source.key];
}

/** True when the text is one of the shipped French defaults (translated automatically). */
export function isShippedDefault(text: string): boolean {
  return FRENCH_SOURCES.has(text.trim());
}

/* ------------------------------------------------------------------ */
/* Per-language overrides                                              */
/* ------------------------------------------------------------------ */

/**
 * Prop names holding buyer-facing copy. Anything else (URLs, ids, codes, names, e-mails,
 * numbers) is never translated.
 */
const TEXT_PROPS: ReadonlySet<string> = new Set([
  "title",
  "text",
  "heading",
  "body",
  "quote",
  "label",
  "alt",
  "q",
  "a",
  "message",
  "success",
  "badge",
  "buttonText",
  "declineText",
  "caption",
  "placeholder",
  "subtext",
  "question",
  "claimText",
  "usLabel",
  "themLabel",
  "dividerLabel",
  "value",
  "author",
  "signatureRole",
]);
/** Nested objects whose strings are never copy (targeting rules). */
const SKIP_OBJECTS: ReadonlySet<string> = new Set(["conditions"]);

/** A review read from a review app (CSV export, Judge.me): the customer's own words. */
function isImportedItem(item: object): boolean {
  const source = (item as { source?: unknown }).source;
  return source === "csv" || source === "judgeme";
}

export type TextField = {
  /** Dot path inside `props` ("badges.0.label", "variantB.title"). */
  path: string;
  /** Prop name (last segment that is not an index). */
  prop: string;
  /** Base text, as typed in the merchant's language. */
  value: string;
};

/** Every translatable text of a block's props, in display order. */
export function textFields(props: unknown): TextField[] {
  const out: TextField[] = [];
  const walk = (node: unknown, path: string[], prop: string) => {
    if (typeof node === "string") {
      if (TEXT_PROPS.has(prop)) out.push({ path: path.join("."), prop, value: node });
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, i) => {
        // An imported review is shown as the customer wrote it, in its own language: never
        // translated (nor listed as "to translate").
        if (item && typeof item === "object" && !(prop === "items" && isImportedItem(item))) walk(item, [...path, String(i)], prop);
      });
      return;
    }
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        if (SKIP_OBJECTS.has(k)) continue;
        walk(v, [...path, k], k);
      }
    }
  };
  walk(props, [], "");
  return out;
}

type Translations = Partial<Record<Lang, Record<string, string>>>;

/** Text of one field for the buyer: merchant translation → translated default → base text. */
export function resolveText(value: string, path: string, lang: Lang, i18n: Translations | undefined): string {
  const override = i18n?.[lang]?.[path];
  if (override && override.trim()) return override;
  return translateDefault(value, lang);
}

function setPath(target: Record<string, unknown>, path: string, value: string) {
  const parts = path.split(".");
  let node: Record<string, unknown> | unknown[] = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    const child: unknown = (node as Record<string, unknown>)[key];
    if (!child || typeof child !== "object") return;
    const copy: Record<string, unknown> | unknown[] = Array.isArray(child) ? [...child] : { ...(child as Record<string, unknown>) };
    (node as Record<string, unknown>)[key] = copy;
    node = copy;
  }
  (node as Record<string, unknown>)[parts[parts.length - 1]] = value;
}

/** The block with every text in the buyer's language (same object when nothing changes). */
export function localizeBlock<B extends Block>(block: B, lang: Lang): B {
  const i18n = block.i18n as Translations | undefined;
  let props: Record<string, unknown> | null = null;
  for (const field of textFields(block.props)) {
    const text = resolveText(field.value, field.path, lang, i18n);
    if (text === field.value) continue;
    props ??= { ...(block.props as Record<string, unknown>) };
    setPath(props, field.path, text);
  }
  return props ? ({ ...block, props } as B) : block;
}

/**
 * Translations are stored by position ("items.2.text"). When a list of the block changes
 * (item removed, reordered, added, reviews imported / merged), each translation follows its own
 * item, found by identity (the editors keep untouched items as the same object); an item edited
 * in place (same list length, same slot) keeps its translations. Anything else — a translation
 * whose item is gone, or one that would land on an imported review — is dropped, so a
 * translation never ends up on another customer's card.
 */
export function remapListTranslations<B extends Block>(prev: B, next: B): B {
  const i18n = next.i18n as Translations | undefined;
  if (!i18n || prev.i18n !== next.i18n) return next;
  const before = prev.props as Record<string, unknown>;
  const after = next.props as Record<string, unknown>;
  const moves = new Map<string, Map<number, number>>();
  for (const [key, list] of Object.entries(after)) {
    const old = before[key];
    if (!Array.isArray(list) || !Array.isArray(old) || old === list) continue;
    const map = new Map<number, number>();
    const used = new Set<number>();
    list.forEach((item, j) => {
      const i = old.findIndex((o, k) => o === item && !used.has(k));
      if (i >= 0) {
        used.add(i);
        map.set(i, j);
      }
    });
    if (old.length === list.length) {
      // Edited in place: the slot's previous item is gone and nothing took its translations.
      list.forEach((item, j) => {
        if (!used.has(j) && ![...map.values()].includes(j) && !list.includes(old[j])) {
          used.add(j);
          map.set(j, j);
        }
      });
    }
    for (const [i, j] of map) {
      const item = list[j];
      if (key === "items" && item && typeof item === "object" && isImportedItem(item)) map.delete(i);
    }
    moves.set(key, map);
  }
  if (moves.size === 0) return next;
  const out: Translations = {};
  let changed = false;
  for (const [lang, fields] of Object.entries(i18n) as [Lang, Record<string, string>][]) {
    const kept: Record<string, string> = {};
    for (const [path, value] of Object.entries(fields ?? {})) {
      const [key, index, ...rest] = path.split(".");
      const map = moves.get(key);
      if (!map || index == null || !/^\d+$/.test(index)) {
        kept[path] = value;
        continue;
      }
      const to = map.get(Number(index));
      if (to == null) {
        changed = true;
        continue;
      }
      if (to !== Number(index)) changed = true;
      kept[[key, String(to), ...rest].join(".")] = value;
    }
    if (Object.keys(kept).length) out[lang] = kept;
  }
  if (!changed) return next;
  const { i18n: _dropped, ...rest } = next;
  void _dropped;
  return (Object.keys(out).length ? { ...rest, i18n: out } : rest) as B;
}

export function localizeLayout(layout: Layout, lang: Lang): Layout {
  const blocks = layout.blocks.map((b) => localizeBlock(b, lang));
  return blocks.every((b, i) => b === layout.blocks[i]) ? layout : { ...layout, blocks };
}

/** Theme copy shown to buyers ("TVA incluse" → "VAT included"). */
export function localizeTheme<T extends Pick<Theme, "vatNote" | "language">>(theme: T): T {
  const vatNote = translateDefault(theme.vatNote, theme.language);
  return vatNote === theme.vatNote ? theme : { ...theme, vatNote };
}

/* ------------------------------------------------------------------ */
/* Shipping delays typed in French ("2 à 3 jours ouvrés")              */
/* ------------------------------------------------------------------ */

const UNITS: Record<Exclude<Lang, "fr">, Record<"business" | "days" | "weeks", [string, string]>> = {
  en: { business: ["business day", "business days"], days: ["day", "days"], weeks: ["week", "weeks"] },
  de: { business: ["Werktag", "Werktage"], days: ["Tag", "Tage"], weeks: ["Woche", "Wochen"] },
  es: { business: ["día hábil", "días hábiles"], days: ["día", "días"], weeks: ["semana", "semanas"] },
  it: { business: ["giorno lavorativo", "giorni lavorativi"], days: ["giorno", "giorni"], weeks: ["settimana", "settimane"] },
  nl: { business: ["werkdag", "werkdagen"], days: ["dag", "dagen"], weeks: ["week", "weken"] },
};

const FR_DELAY = /^(\d{1,3})(?:\s*(?:à|a|-|–|—)\s*(\d{1,3}))?\s*(jours?\s+ouvr(?:é|e|able)s?|jours?|j|semaines?|h|heures?)$/i;

/**
 * "2 à 3 jours ouvrés" → "2–3 business days" (EN), "2–3 Werktage" (DE)… Texts that are not
 * a plain French delay come back unchanged, and French stays as typed.
 */
export function localizeDeliveryTime(text: string, lang: Lang): string {
  if (lang === "fr" || !text) return text;
  const m = FR_DELAY.exec(text.trim());
  if (!m) return text;
  const [, from, to, unitRaw] = m;
  const range = to && to !== from ? `${from}–${to}` : from;
  const unit = unitRaw.toLowerCase();
  if (unit === "h" || unit.startsWith("heure")) return `${range} h`;
  const kind = unit.startsWith("semaine") ? "weeks" : /ouvr/.test(unit) ? "business" : "days";
  const [one, many] = UNITS[lang][kind];
  return `${range} ${range === "1" ? one : many}`;
}

/* ------------------------------------------------------------------ */
/* Built-in wording of empty fields                                    */
/* ------------------------------------------------------------------ */

/**
 * What buyers read when a text prop is left empty ("" title of Contact → "Contact"), in
 * `lang`; null when an empty field simply shows nothing. Mirrors the checkout / thank-you
 * fallbacks (`block.props.title || L.contact`).
 */
export function emptyTextDefault(type: Block["type"], path: string, lang: Lang): string | null {
  const L = LABELS[lang];
  const byType: Partial<Record<Block["type"], Record<string, string>>> = {
    express: { title: L.expressCheckout, dividerLabel: L.or },
    contact: { title: L.contact },
    delivery: { title: L.shippingAddress },
    shipping_method: { title: L.shippingMethod },
    payment: { title: L.payment },
    order_addons: { title: L.addons },
    ty_confirmation: { title: L.thankYou("{name}") },
    ty_details: { title: L.shipTo },
    ty_summary: { title: L.summary },
    recommendations: { title: L.recoTitle },
    shipping_protection: { title: L.protectionTitle, text: L.protectionText },
    survey: { question: L.surveyQuestion },
  };
  return byType[type]?.[path] ?? null;
}

/* ------------------------------------------------------------------ */
/* Translations of dashboard records (order bumps, gifts, rates)       */
/* ------------------------------------------------------------------ */

/**
 * Buyer-language texts of a record edited outside the builder: an order bump (title,
 * description), a free-gift tier (title), a custom shipping rate (name, deliveryTime).
 * Stored as `{ [lang]: { [field]: text } }` next to the base texts (the store's language).
 * Shopify orders keep the base texts (store language); only what buyers read is translated.
 */
export type RecordTranslations = Partial<Record<Lang, Record<string, string>>>;

export const RECORD_TEXT_MAX = 400;

/** Validated translations: known languages and fields, trimmed non-empty strings (≤ 400 chars); null when none. Pure. */
export function cleanRecordI18n(raw: unknown, fields: readonly string[]): RecordTranslations | null {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = value.trim() ? JSON.parse(value) : null;
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: RecordTranslations = {};
  for (const [lang, entries] of Object.entries(value as Record<string, unknown>)) {
    if (!(lang in LABELS) || !entries || typeof entries !== "object" || Array.isArray(entries)) continue;
    const kept: Record<string, string> = {};
    for (const f of fields) {
      const v = (entries as Record<string, unknown>)[f];
      if (typeof v === "string" && v.trim()) kept[f] = v.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, RECORD_TEXT_MAX);
    }
    if (Object.keys(kept).length) out[lang as Lang] = kept;
  }
  return Object.keys(out).length ? out : null;
}

/** A record's text in the buyer's language: the merchant's translation, else the base text as typed. Pure. */
export function recordText<T extends string | null | undefined>(base: T, field: string, lang: Lang, i18n: unknown): T | string {
  const t = i18n && typeof i18n === "object" ? (i18n as RecordTranslations)[lang]?.[field] : undefined;
  return typeof t === "string" && t.trim() ? t : base;
}

/** A shipping rate as the buyer reads it (name and delivery time translated; untranslated French delays converted). Pure. */
export function localizeRate<R extends { name: string; deliveryTime: string | null; i18n?: unknown }>(rate: R, lang: Lang): R {
  const name = recordText(rate.name, "name", lang, rate.i18n);
  const own = recordText<string | null>(null, "deliveryTime", lang, rate.i18n);
  const deliveryTime = own ?? (rate.deliveryTime ? localizeDeliveryTime(rate.deliveryTime, lang) : rate.deliveryTime);
  return { ...rate, name, deliveryTime };
}
