import type { Lang, ReviewsNoteSummary } from "./i18n-core";

/*
 * The checkout's texts that are formulas (a count, an amount or a name put into the sentence), in all
 * six languages: functions can't travel as data, so the buyer's page carries them all. The plain texts
 * come with the page, in the buyer's language only (CheckoutText, sent by the server): labelsOf puts
 * the two together.
 */

/** "The average rating covers …" sentence, one per language (under the reviews block). */
const AVERAGE_SCOPE = {
  fr: (s: Exclude<ReviewsNoteSummary, false>) =>
    s === "file"
      ? "La note moyenne porte sur tous les avis du fichier importé."
      : s === "store"
        ? "La note moyenne porte sur tous les avis publiés de la boutique."
        : s === "store-partial"
          ? "La note moyenne porte sur une partie des avis publiés de la boutique."
          : typeof s === "object"
            ? `La note moyenne porte sur les ${s.recent} avis les plus récents.`
            : "La note moyenne porte sur tous les avis publiés.",
  en: (s: Exclude<ReviewsNoteSummary, false>) =>
    s === "file"
      ? "The average rating covers all reviews in the imported file."
      : s === "store"
        ? "The average rating covers all of the store's published reviews."
        : s === "store-partial"
          ? "The average rating covers part of the store's published reviews."
          : typeof s === "object"
            ? `The average rating covers the ${s.recent} most recent reviews.`
            : "The average rating covers all published reviews.",
  de: (s: Exclude<ReviewsNoteSummary, false>) =>
    s === "file"
      ? "Die Durchschnittsbewertung bezieht sich auf alle Bewertungen der importierten Datei."
      : s === "store"
        ? "Die Durchschnittsbewertung bezieht sich auf alle veröffentlichten Bewertungen des Shops."
        : s === "store-partial"
          ? "Die Durchschnittsbewertung bezieht sich auf einen Teil der veröffentlichten Bewertungen des Shops."
          : typeof s === "object"
            ? `Die Durchschnittsbewertung bezieht sich auf die ${s.recent} neuesten Bewertungen.`
            : "Die Durchschnittsbewertung bezieht sich auf alle veröffentlichten Bewertungen.",
  es: (s: Exclude<ReviewsNoteSummary, false>) =>
    s === "file"
      ? "La valoración media se basa en todas las opiniones del archivo importado."
      : s === "store"
        ? "La valoración media se basa en todas las opiniones publicadas de la tienda."
        : s === "store-partial"
          ? "La valoración media se basa en una parte de las opiniones publicadas de la tienda."
          : typeof s === "object"
            ? `La valoración media se basa en las ${s.recent} opiniones más recientes.`
            : "La valoración media se basa en todas las opiniones publicadas.",
  it: (s: Exclude<ReviewsNoteSummary, false>) =>
    s === "file"
      ? "La valutazione media si basa su tutte le recensioni del file importato."
      : s === "store"
        ? "La valutazione media si basa su tutte le recensioni pubblicate del negozio."
        : s === "store-partial"
          ? "La valutazione media si basa su una parte delle recensioni pubblicate del negozio."
          : typeof s === "object"
            ? `La valutazione media si basa sulle ${s.recent} recensioni più recenti.`
            : "La valutazione media si basa su tutte le recensioni pubblicate.",
  nl: (s: Exclude<ReviewsNoteSummary, false>) =>
    s === "file"
      ? "De gemiddelde score is gebaseerd op alle reviews uit het geïmporteerde bestand."
      : s === "store"
        ? "De gemiddelde score is gebaseerd op alle gepubliceerde reviews van de winkel."
        : s === "store-partial"
          ? "De gemiddelde score is gebaseerd op een deel van de gepubliceerde reviews van de winkel."
          : typeof s === "object"
            ? `De gemiddelde score is gebaseerd op de ${s.recent} meest recente reviews.`
            : "De gemiddelde score is gebaseerd op alle gepubliceerde reviews.",
};

export const LABEL_FNS = {
  fr: {
    removeCode: (code: string) => `Retirer le code ${code}`,
    items: (n: number) => `${n} article${n > 1 ? "s" : ""}`,
    thankYou: (name: string) => (name ? `Merci, ${name} !` : "Merci !"),
    confirmationSent: (email: string) => `Confirmation envoyée à ${email}`,
    upsellAdded: (name: string) => `Ajouté ! Commande ${name} confirmée.`,
    upsellShopCurrency: (shop: string, paid: string) => `Débité en ${shop}, la devise de la boutique (votre commande a été payée en ${paid}).`,
    youSave: (amount: string) => `Vous économisez ${amount}`,
    totalUpdatedLive: (amount: string) => `Nouveau total : ${amount}`,
    completeFields: (f: string) => `Complétez : ${f}`,
    reviewN: (n: number) => `Avis ${n}`,
    // `n`: the count as written in the buyer's locale; `count`: the number itself, for the
    // plural rules of the other languages ("avis" is invariable).
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    reviewsCount: (n: string, count?: number) => `${n} avis`,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    reviewsSummary: (score: string, n: string, count?: number) => `Note moyenne : ${score} sur 5, ${n} avis`,
    /** Screen-reader name of a star row: `n` as written in the buyer's locale, `count` for the plural. */
    starsOutOf5: (n: string, count: number) => `${n} ${count >= 2 ? "étoiles" : "étoile"} sur 5`,
    moreReviews: (n: number) => `Voir ${n} avis de plus`,
    /** Under a reviews block showing imported reviews (EU Omnibus: where reviews come from). */
    importedReviewsNote: (app: string | null, o: { mixed?: boolean; summary?: ReviewsNoteSummary } = {}) =>
      `${o.mixed ? "Sélection d'avis, dont certains importés" : "Sélection d'avis importés"} de ${app ?? "l'application d'avis de la boutique"} ; « Achat vérifié » indique un achat confirmé par l'application.` +
      (o.summary ? ` ${AVERAGE_SCOPE.fr(o.summary)}` : ""),
    /** What the shown average covers, alone (reviews block without imported reviews). */
    averageScope: AVERAGE_SCOPE.fr,
    quantity: (n: number) => `Quantité : ${n}`,
    addressSuggestions: (n: number) => `${n} adresse${n > 1 ? "s" : ""} suggérée${n > 1 ? "s" : ""} : flèches pour choisir, Entrée pour valider`,
    qtyDecrease: (name: string) => `Diminuer la quantité de ${name}`,
    qtyIncrease: (name: string) => `Augmenter la quantité de ${name}`,
    qtyRemove: (name: string) => `Retirer ${name} du panier`,
    qtyChanged: (name: string, n: number) => `${name} : quantité ${n}`,
    qtyRemoved: (name: string) => `${name} retiré du panier`,
    cartCodeNotApplied: (code: string) => `Le code ${code} de votre panier ne s'applique pas ici.`,
    recoAddLabel: (name: string, price: string) => `Ajouter ${name} à la commande, ${price}`,
    recoAdded: (name: string) => `${name} ajouté à la commande`,
    localEstimate: (amount: string, currency: string) => `Vous serez débité en ${currency} ; montant indicatif ≈ ${amount} (taux BCE, le montant final dépend de votre banque)`,
    chargedIn: (amount: string, currency: string) => `Vous serez débité de ${amount} (prix en ${currency} converti au taux de référence BCE du jour)`,
    volumeNudge: (n: number, pct: string) => (n === 1 ? `Plus qu'un article pour −${pct} %` : `Plus que ${n} articles pour −${pct} %`),
    volumeAddOne: (name: string) => `Ajouter 1 ${name}`,
    volumeApplied: (pct: string) => `Remise quantité −${pct} % appliquée`,
    volumeRow: (pct: string) => `Remise quantité (−${pct} %)`,
    dealAmountUnit: (amount: string) => `−${amount} par article`,
    dealAmountBundle: (amount: string, n: number) => `−${amount} par lot de ${n}`,
    dealPrice: (n: number, amount: string) => `${n} pour ${amount}`,
    dealBxgy: (buy: number, free: number) => `${buy} acheté${buy > 1 ? "s" : ""}, ${free} offert${free > 1 ? "s" : ""}`,
    volumeNudgeDeal: (n: number, deal: string) => (n === 1 ? `Plus qu'un article pour « ${deal} »` : `Plus que ${n} articles pour « ${deal} »`),
    volumeAppliedDeal: (deal: string) => `Offre « ${deal} » appliquée`,
    volumeRowDeal: (deal: string) => `Offre quantité (${deal})`,
    claimEmailHint: (masked: string) => `Commande passée avec ${masked} — confirmez cet e-mail.`,
    claimPhotosCount: (n: number, max: number) => `${n}/${max} photo${n > 1 ? "s" : ""}`,
    claimPhotoRemove: (i: number) => `Retirer la photo ${i}`,
    claimPhotoPreview: (i: number) => `Photo ${i}`,
    pickupFound: (n: number) => `${n} point${n > 1 ? "s" : ""} relais trouvé${n > 1 ? "s" : ""}`,
    pickupDeliveredAt: (name: string) => `Livré chez ${name}`,
    emailSuggest: (email: string) => `Vouliez-vous dire ${email} ?`,
    errZipFor: (country: string, example: string) => `Code postal invalide pour le pays choisi (${country}, ex. : ${example})`,
    offerValidFor: (min: number) => `Offre valable encore ${min} min`,
    continueAs: (email: string) => `Continuer en tant que ${email}`,
    giftNudgeAmount: (amount: string, gift: string) => `Plus que ${amount} pour recevoir ${gift}`,
    giftNudgeItems: (n: number, gift: string) => (n === 1 ? `Plus qu'un article pour recevoir ${gift}` : `Plus que ${n} articles pour recevoir ${gift}`),
    giftEarned: (gift: string) => `${gift} offert avec votre commande`,
    upsellOff: (pct: string) => `−${pct} %`,
  },
  en: {
    removeCode: (code: string) => `Remove code ${code}`,
    items: (n: number) => `${n} item${n > 1 ? "s" : ""}`,
    thankYou: (name: string) => (name ? `Thank you, ${name}!` : "Thank you!"),
    confirmationSent: (email: string) => `Confirmation sent to ${email}`,
    upsellAdded: (name: string) => `Added! Order ${name} confirmed.`,
    upsellShopCurrency: (shop: string, paid: string) => `Charged in ${shop}, the shop's currency (your order was paid in ${paid}).`,
    youSave: (amount: string) => `You save ${amount}`,
    totalUpdatedLive: (amount: string) => `New total: ${amount}`,
    completeFields: (f: string) => `Complete: ${f}`,
    reviewN: (n: number) => `Review ${n}`,
    reviewsCount: (n: string, count?: number) => `${n} ${count === 1 ? "review" : "reviews"}`,
    reviewsSummary: (score: string, n: string, count?: number) => `Average rating: ${score} out of 5, ${n} ${count === 1 ? "review" : "reviews"}`,
    starsOutOf5: (n: string, count: number) => `${n} ${count === 1 ? "star" : "stars"} out of 5`,
    moreReviews: (n: number) => (n === 1 ? "Show 1 more review" : `Show ${n} more reviews`),
    importedReviewsNote: (app: string | null, o: { mixed?: boolean; summary?: ReviewsNoteSummary } = {}) =>
      `${o.mixed ? "A selection of reviews, some imported" : "A selection of reviews imported"} from ${app ?? "the store's review app"}; “Verified purchase” means the purchase was confirmed by the app.` +
      (o.summary ? ` ${AVERAGE_SCOPE.en(o.summary)}` : ""),
    averageScope: AVERAGE_SCOPE.en,
    quantity: (n: number) => `Quantity: ${n}`,
    addressSuggestions: (n: number) => `${n} suggested address${n > 1 ? "es" : ""}: use the arrow keys, Enter to select`,
    qtyDecrease: (name: string) => `Decrease quantity of ${name}`,
    qtyIncrease: (name: string) => `Increase quantity of ${name}`,
    qtyRemove: (name: string) => `Remove ${name} from cart`,
    qtyChanged: (name: string, n: number) => `${name}: quantity ${n}`,
    qtyRemoved: (name: string) => `${name} removed from cart`,
    cartCodeNotApplied: (code: string) => `Your cart's code ${code} doesn't apply here.`,
    recoAddLabel: (name: string, price: string) => `Add ${name} to your order, ${price}`,
    recoAdded: (name: string) => `${name} added to your order`,
    localEstimate: (amount: string, currency: string) => `You will be charged in ${currency}; indicative amount ≈ ${amount} (ECB rate, the final amount depends on your bank)`,
    chargedIn: (amount: string, currency: string) => `You will be charged ${amount} (${currency} price converted at today's ECB reference rate)`,
    volumeNudge: (n: number, pct: string) => `Add ${n} more item${n > 1 ? "s" : ""} to save ${pct}%`,
    volumeAddOne: (name: string) => `Add 1 ${name}`,
    volumeApplied: (pct: string) => `${pct}% volume discount applied`,
    volumeRow: (pct: string) => `Volume discount (−${pct}%)`,
    dealAmountUnit: (amount: string) => `${amount} off each item`,
    dealAmountBundle: (amount: string, n: number) => `${amount} off every ${n}`,
    dealPrice: (n: number, amount: string) => `${n} for ${amount}`,
    dealBxgy: (buy: number, free: number) => `Buy ${buy}, get ${free} free`,
    volumeNudgeDeal: (n: number, deal: string) => `Add ${n} more item${n > 1 ? "s" : ""} for “${deal}”`,
    volumeAppliedDeal: (deal: string) => `“${deal}” applied`,
    volumeRowDeal: (deal: string) => `Bundle deal (${deal})`,
    claimEmailHint: (masked: string) => `Order placed with ${masked} — confirm this e-mail.`,
    claimPhotosCount: (n: number, max: number) => `${n}/${max} photo${n > 1 ? "s" : ""}`,
    claimPhotoRemove: (i: number) => `Remove photo ${i}`,
    claimPhotoPreview: (i: number) => `Photo ${i}`,
    pickupFound: (n: number) => `${n} pickup point${n > 1 ? "s" : ""} found`,
    pickupDeliveredAt: (name: string) => `Delivered to ${name}`,
    emailSuggest: (email: string) => `Did you mean ${email}?`,
    errZipFor: (country: string, example: string) => `Enter a valid postal code for ${country} (e.g. ${example})`,
    offerValidFor: (min: number) => `Offer valid for ${min} more min`,
    continueAs: (email: string) => `Continue as ${email}`,
    giftNudgeAmount: (amount: string, gift: string) => `Only ${amount} more to get ${gift}`,
    giftNudgeItems: (n: number, gift: string) => `Add ${n} more item${n > 1 ? "s" : ""} to get ${gift}`,
    giftEarned: (gift: string) => `${gift} free with your order`,
    upsellOff: (pct: string) => `−${pct}%`,
  },
  de: {
    removeCode: (code: string) => `Code ${code} entfernen`,
    items: (n: number) => `${n} Artikel`,
    thankYou: (name: string) => (name ? `Danke, ${name}!` : "Danke!"),
    confirmationSent: (email: string) => `Bestätigung gesendet an ${email}`,
    upsellAdded: (name: string) => `Hinzugefügt! Bestellung ${name} bestätigt.`,
    upsellShopCurrency: (shop: string, paid: string) => `Abbuchung in ${shop}, der Währung des Shops (Ihre Bestellung wurde in ${paid} bezahlt).`,
    youSave: (amount: string) => `Sie sparen ${amount}`,
    totalUpdatedLive: (amount: string) => `Neuer Gesamtbetrag: ${amount}`,
    completeFields: (f: string) => `Bitte ergänzen: ${f}`,
    reviewN: (n: number) => `Bewertung ${n}`,
    reviewsCount: (n: string, count?: number) => `${n} ${count === 1 ? "Bewertung" : "Bewertungen"}`,
    reviewsSummary: (score: string, n: string, count?: number) => `Durchschnittliche Bewertung: ${score} von 5, ${n} ${count === 1 ? "Bewertung" : "Bewertungen"}`,
    // "von 5 Sternen": the noun counts the 5 (always plural), not the rating (1 von 5 Sternen).
    starsOutOf5: (n: string) => `${n} von 5 Sternen`,
    moreReviews: (n: number) => (n === 1 ? "1 weitere Bewertung anzeigen" : `${n} weitere Bewertungen anzeigen`),
    importedReviewsNote: (app: string | null, o: { mixed?: boolean; summary?: ReviewsNoteSummary } = {}) =>
      `${o.mixed ? "Auswahl von Bewertungen, teils importiert" : "Auswahl von Bewertungen, importiert"} aus ${app ?? "der Bewertungs-App des Shops"}; „Verifizierter Kauf“ bedeutet, dass die App den Kauf bestätigt hat.` +
      (o.summary ? ` ${AVERAGE_SCOPE.de(o.summary)}` : ""),
    averageScope: AVERAGE_SCOPE.de,
    quantity: (n: number) => `Menge: ${n}`,
    addressSuggestions: (n: number) => `${n} ${n > 1 ? "Adressvorschläge" : "Adressvorschlag"}: Pfeiltasten zum Auswählen, Eingabe zum Bestätigen`,
    qtyDecrease: (name: string) => `Menge von ${name} verringern`,
    qtyIncrease: (name: string) => `Menge von ${name} erhöhen`,
    qtyRemove: (name: string) => `${name} aus dem Warenkorb entfernen`,
    qtyChanged: (name: string, n: number) => `${name}: Menge ${n}`,
    qtyRemoved: (name: string) => `${name} aus dem Warenkorb entfernt`,
    cartCodeNotApplied: (code: string) => `Der Code ${code} Ihres Warenkorbs gilt hier nicht.`,
    recoAddLabel: (name: string, price: string) => `${name} zur Bestellung hinzufügen, ${price}`,
    recoAdded: (name: string) => `${name} zur Bestellung hinzugefügt`,
    localEstimate: (amount: string, currency: string) => `Die Abbuchung erfolgt in ${currency}; Richtwert ≈ ${amount} (EZB-Kurs, der Endbetrag hängt von Ihrer Bank ab)`,
    chargedIn: (amount: string, currency: string) => `Ihnen werden ${amount} belastet (${currency}-Preis zum heutigen EZB-Referenzkurs umgerechnet)`,
    volumeNudge: (n: number, pct: string) => `Noch ${n} Artikel für −${pct} %`,
    volumeAddOne: (name: string) => `1 × ${name} hinzufügen`,
    volumeApplied: (pct: string) => `Mengenrabatt −${pct} % angewendet`,
    volumeRow: (pct: string) => `Mengenrabatt (−${pct} %)`,
    dealAmountUnit: (amount: string) => `−${amount} pro Artikel`,
    dealAmountBundle: (amount: string, n: number) => `−${amount} je ${n} Stück`,
    dealPrice: (n: number, amount: string) => `${n} für ${amount}`,
    dealBxgy: (buy: number, free: number) => `${buy} kaufen, ${free} gratis`,
    volumeNudgeDeal: (n: number, deal: string) => `Noch ${n} Artikel für „${deal}“`,
    volumeAppliedDeal: (deal: string) => `„${deal}“ angewendet`,
    volumeRowDeal: (deal: string) => `Mengenangebot (${deal})`,
    claimEmailHint: (masked: string) => `Bestellt mit ${masked} — bestätigen Sie diese E-Mail.`,
    claimPhotosCount: (n: number, max: number) => `${n}/${max} ${n === 1 ? "Foto" : "Fotos"}`,
    claimPhotoRemove: (i: number) => `Foto ${i} entfernen`,
    claimPhotoPreview: (i: number) => `Foto ${i}`,
    pickupFound: (n: number) => `${n} Abholstation${n > 1 ? "en" : ""} gefunden`,
    pickupDeliveredAt: (name: string) => `Lieferung an ${name}`,
    emailSuggest: (email: string) => `Meinten Sie ${email}?`,
    errZipFor: (country: string, example: string) => `Ungültige Postleitzahl für ${country} (z. B. ${example})`,
    offerValidFor: (min: number) => `Angebot noch ${min} Min. gültig`,
    continueAs: (email: string) => `Weiter als ${email}`,
    giftNudgeAmount: (amount: string, gift: string) => `Nur noch ${amount} bis ${gift} gratis`,
    giftNudgeItems: (n: number, gift: string) => `Noch ${n} Artikel bis ${gift} gratis`,
    giftEarned: (gift: string) => `${gift} gratis zu Ihrer Bestellung`,
    upsellOff: (pct: string) => `−${pct} %`,
  },
  es: {
    removeCode: (code: string) => `Quitar el código ${code}`,
    items: (n: number) => `${n} artículo${n > 1 ? "s" : ""}`,
    thankYou: (name: string) => (name ? `¡Gracias, ${name}!` : "¡Gracias!"),
    confirmationSent: (email: string) => `Confirmación enviada a ${email}`,
    upsellAdded: (name: string) => `¡Añadido! Pedido ${name} confirmado.`,
    upsellShopCurrency: (shop: string, paid: string) => `Cargado en ${shop}, la moneda de la tienda (tu pedido se pagó en ${paid}).`,
    youSave: (amount: string) => `Ahorras ${amount}`,
    totalUpdatedLive: (amount: string) => `Nuevo total: ${amount}`,
    completeFields: (f: string) => `Completa: ${f}`,
    reviewN: (n: number) => `Opinión ${n}`,
    reviewsCount: (n: string, count?: number) => `${n} ${count === 1 ? "opinión" : "opiniones"}`,
    reviewsSummary: (score: string, n: string, count?: number) => `Valoración media: ${score} de 5, ${n} ${count === 1 ? "opinión" : "opiniones"}`,
    // "de 5 estrellas": the noun counts the 5 (always plural): 1 de 5 estrellas.
    starsOutOf5: (n: string) => `${n} de 5 estrellas`,
    moreReviews: (n: number) => (n === 1 ? "Ver 1 opinión más" : `Ver ${n} opiniones más`),
    importedReviewsNote: (app: string | null, o: { mixed?: boolean; summary?: ReviewsNoteSummary } = {}) =>
      `${o.mixed ? "Selección de opiniones, algunas importadas" : "Selección de opiniones importadas"} de ${app ?? "la aplicación de opiniones de la tienda"}; «Compra verificada» indica una compra confirmada por la aplicación.` +
      (o.summary ? ` ${AVERAGE_SCOPE.es(o.summary)}` : ""),
    averageScope: AVERAGE_SCOPE.es,
    quantity: (n: number) => `Cantidad: ${n}`,
    addressSuggestions: (n: number) => `${n} ${n > 1 ? "direcciones sugeridas" : "dirección sugerida"}: usa las flechas e Intro para elegir`,
    qtyDecrease: (name: string) => `Reducir la cantidad de ${name}`,
    qtyIncrease: (name: string) => `Aumentar la cantidad de ${name}`,
    qtyRemove: (name: string) => `Quitar ${name} del carrito`,
    qtyChanged: (name: string, n: number) => `${name}: cantidad ${n}`,
    qtyRemoved: (name: string) => `${name} quitado del carrito`,
    cartCodeNotApplied: (code: string) => `El código ${code} de tu carrito no se aplica aquí.`,
    recoAddLabel: (name: string, price: string) => `Añadir ${name} al pedido, ${price}`,
    recoAdded: (name: string) => `${name} añadido al pedido`,
    localEstimate: (amount: string, currency: string) => `Se te cobrará en ${currency}; importe orientativo ≈ ${amount} (tipo del BCE, el importe final depende de tu banco)`,
    chargedIn: (amount: string, currency: string) => `Se te cobrarán ${amount} (precio en ${currency} convertido al tipo de referencia del BCE de hoy)`,
    volumeNudge: (n: number, pct: string) => `Añade ${n} artículo${n > 1 ? "s" : ""} más para −${pct} %`,
    volumeAddOne: (name: string) => `Añadir 1 ${name}`,
    volumeApplied: (pct: string) => `Descuento por cantidad −${pct} % aplicado`,
    volumeRow: (pct: string) => `Descuento por cantidad (−${pct} %)`,
    dealAmountUnit: (amount: string) => `−${amount} por artículo`,
    dealAmountBundle: (amount: string, n: number) => `−${amount} por cada ${n}`,
    dealPrice: (n: number, amount: string) => `${n} por ${amount}`,
    dealBxgy: (buy: number, free: number) => `Compra ${buy} y llévate ${free} gratis`,
    volumeNudgeDeal: (n: number, deal: string) => `Añade ${n} artículo${n > 1 ? "s" : ""} más para «${deal}»`,
    volumeAppliedDeal: (deal: string) => `«${deal}» aplicado`,
    volumeRowDeal: (deal: string) => `Oferta por cantidad (${deal})`,
    claimEmailHint: (masked: string) => `Pedido realizado con ${masked} — confirma este e-mail.`,
    claimPhotosCount: (n: number, max: number) => `${n}/${max} foto${n === 1 ? "" : "s"}`,
    claimPhotoRemove: (i: number) => `Quitar la foto ${i}`,
    claimPhotoPreview: (i: number) => `Foto ${i}`,
    pickupFound: (n: number) => `${n} punto${n > 1 ? "s" : ""} de recogida encontrado${n > 1 ? "s" : ""}`,
    pickupDeliveredAt: (name: string) => `Entrega en ${name}`,
    emailSuggest: (email: string) => `¿Quisiste decir ${email}?`,
    errZipFor: (country: string, example: string) => `Código postal no válido para ${country} (p. ej. ${example})`,
    offerValidFor: (min: number) => `Oferta válida ${min} min más`,
    continueAs: (email: string) => `Continuar como ${email}`,
    giftNudgeAmount: (amount: string, gift: string) => `Solo ${amount} más para recibir ${gift}`,
    giftNudgeItems: (n: number, gift: string) => `Añade ${n} artículo${n > 1 ? "s" : ""} más para recibir ${gift}`,
    giftEarned: (gift: string) => `${gift} de regalo con tu pedido`,
    upsellOff: (pct: string) => `−${pct} %`,
  },
  it: {
    removeCode: (code: string) => `Rimuovi il codice ${code}`,
    items: (n: number) => `${n} articol${n > 1 ? "i" : "o"}`,
    thankYou: (name: string) => (name ? `Grazie, ${name}!` : "Grazie!"),
    confirmationSent: (email: string) => `Conferma inviata a ${email}`,
    upsellAdded: (name: string) => `Aggiunto! Ordine ${name} confermato.`,
    upsellShopCurrency: (shop: string, paid: string) => `Addebitato in ${shop}, la valuta del negozio (il tuo ordine è stato pagato in ${paid}).`,
    youSave: (amount: string) => `Risparmi ${amount}`,
    totalUpdatedLive: (amount: string) => `Nuovo totale: ${amount}`,
    completeFields: (f: string) => `Completa: ${f}`,
    reviewN: (n: number) => `Recensione ${n}`,
    reviewsCount: (n: string, count?: number) => `${n} ${count === 1 ? "recensione" : "recensioni"}`,
    reviewsSummary: (score: string, n: string, count?: number) => `Valutazione media: ${score} su 5, ${n} ${count === 1 ? "recensione" : "recensioni"}`,
    starsOutOf5: (n: string, count: number) => `${n} ${count === 1 ? "stella" : "stelle"} su 5`,
    moreReviews: (n: number) => (n === 1 ? "Mostra un'altra recensione" : `Mostra altre ${n} recensioni`),
    importedReviewsNote: (app: string | null, o: { mixed?: boolean; summary?: ReviewsNoteSummary } = {}) =>
      `${o.mixed ? "Selezione di recensioni, alcune importate" : "Selezione di recensioni importate"} ${app ? `da ${app}` : "dall'app di recensioni del negozio"}; «Acquisto verificato» indica un acquisto confermato dall'app.` +
      (o.summary ? ` ${AVERAGE_SCOPE.it(o.summary)}` : ""),
    averageScope: AVERAGE_SCOPE.it,
    quantity: (n: number) => `Quantità: ${n}`,
    addressSuggestions: (n: number) => `${n} ${n > 1 ? "indirizzi suggeriti" : "indirizzo suggerito"}: frecce per scegliere, Invio per confermare`,
    qtyDecrease: (name: string) => `Diminuisci la quantità di ${name}`,
    qtyIncrease: (name: string) => `Aumenta la quantità di ${name}`,
    qtyRemove: (name: string) => `Rimuovi ${name} dal carrello`,
    qtyChanged: (name: string, n: number) => `${name}: quantità ${n}`,
    qtyRemoved: (name: string) => `${name} rimosso dal carrello`,
    cartCodeNotApplied: (code: string) => `Il codice ${code} del tuo carrello non si applica qui.`,
    recoAddLabel: (name: string, price: string) => `Aggiungi ${name} all'ordine, ${price}`,
    recoAdded: (name: string) => `${name} aggiunto all'ordine`,
    localEstimate: (amount: string, currency: string) => `L'addebito avverrà in ${currency}; importo indicativo ≈ ${amount} (cambio BCE, l'importo finale dipende dalla tua banca)`,
    chargedIn: (amount: string, currency: string) => `Ti verranno addebitati ${amount} (prezzo in ${currency} convertito al cambio di riferimento BCE di oggi)`,
    volumeNudge: (n: number, pct: string) => `Ancora ${n} articol${n > 1 ? "i" : "o"} per −${pct}%`,
    volumeAddOne: (name: string) => `Aggiungi 1 ${name}`,
    volumeApplied: (pct: string) => `Sconto quantità −${pct}% applicato`,
    volumeRow: (pct: string) => `Sconto quantità (−${pct}%)`,
    dealAmountUnit: (amount: string) => `−${amount} per articolo`,
    dealAmountBundle: (amount: string, n: number) => `−${amount} ogni ${n}`,
    dealPrice: (n: number, amount: string) => `${n} a ${amount}`,
    dealBxgy: (buy: number, free: number) => `Compri ${buy}, ${free} in omaggio`,
    volumeNudgeDeal: (n: number, deal: string) => `Ancora ${n} articol${n > 1 ? "i" : "o"} per «${deal}»`,
    volumeAppliedDeal: (deal: string) => `«${deal}» applicata`,
    volumeRowDeal: (deal: string) => `Offerta quantità (${deal})`,
    claimEmailHint: (masked: string) => `Ordine effettuato con ${masked} — conferma questa e-mail.`,
    claimPhotosCount: (n: number, max: number) => `${n}/${max} foto`,
    claimPhotoRemove: (i: number) => `Rimuovi la foto ${i}`,
    claimPhotoPreview: (i: number) => `Foto ${i}`,
    pickupFound: (n: number) => `${n} punt${n > 1 ? "i" : "o"} di ritiro trovat${n > 1 ? "i" : "o"}`,
    pickupDeliveredAt: (name: string) => `Consegna presso ${name}`,
    emailSuggest: (email: string) => `Intendevi ${email}?`,
    errZipFor: (country: string, example: string) => `CAP non valido per il paese scelto (${country}, es. ${example})`,
    offerValidFor: (min: number) => `Offerta valida ancora ${min} min`,
    continueAs: (email: string) => `Continua come ${email}`,
    giftNudgeAmount: (amount: string, gift: string) => `Ancora ${amount} per ricevere ${gift}`,
    giftNudgeItems: (n: number, gift: string) => (n === 1 ? `Ancora un articolo per ricevere ${gift}` : `Ancora ${n} articoli per ricevere ${gift}`),
    giftEarned: (gift: string) => `${gift} in omaggio con il tuo ordine`,
    upsellOff: (pct: string) => `−${pct}%`,
  },
  nl: {
    removeCode: (code: string) => `Code ${code} verwijderen`,
    items: (n: number) => `${n} artikel${n > 1 ? "en" : ""}`,
    thankYou: (name: string) => (name ? `Bedankt, ${name}!` : "Bedankt!"),
    confirmationSent: (email: string) => `Bevestiging verstuurd naar ${email}`,
    upsellAdded: (name: string) => `Toegevoegd! Bestelling ${name} bevestigd.`,
    upsellShopCurrency: (shop: string, paid: string) => `Afgeschreven in ${shop}, de valuta van de winkel (je bestelling is betaald in ${paid}).`,
    youSave: (amount: string) => `Je bespaart ${amount}`,
    totalUpdatedLive: (amount: string) => `Nieuw totaal: ${amount}`,
    completeFields: (f: string) => `Vul aan: ${f}`,
    reviewN: (n: number) => `Review ${n}`,
    reviewsCount: (n: string, count?: number) => `${n} ${count === 1 ? "review" : "reviews"}`,
    reviewsSummary: (score: string, n: string, count?: number) => `Gemiddelde beoordeling: ${score} van 5, ${n} ${count === 1 ? "review" : "reviews"}`,
    // "van 5 sterren": the noun counts the 5 (always plural): 1 van 5 sterren.
    starsOutOf5: (n: string) => `${n} van 5 sterren`,
    moreReviews: (n: number) => (n === 1 ? "Toon nog 1 review" : `Toon nog ${n} reviews`),
    importedReviewsNote: (app: string | null, o: { mixed?: boolean; summary?: ReviewsNoteSummary } = {}) =>
      `${o.mixed ? "Selectie van reviews, deels geïmporteerd" : "Selectie van reviews geïmporteerd"} uit ${app ?? "de review-app van de winkel"}; ‘Geverifieerde aankoop’ betekent dat de app de aankoop heeft bevestigd.` +
      (o.summary ? ` ${AVERAGE_SCOPE.nl(o.summary)}` : ""),
    averageScope: AVERAGE_SCOPE.nl,
    quantity: (n: number) => `Aantal: ${n}`,
    addressSuggestions: (n: number) => `${n} ${n > 1 ? "voorgestelde adressen" : "voorgesteld adres"}: pijltjestoetsen om te kiezen, Enter om te bevestigen`,
    qtyDecrease: (name: string) => `Aantal van ${name} verlagen`,
    qtyIncrease: (name: string) => `Aantal van ${name} verhogen`,
    qtyRemove: (name: string) => `${name} uit winkelwagen verwijderen`,
    qtyChanged: (name: string, n: number) => `${name}: aantal ${n}`,
    qtyRemoved: (name: string) => `${name} uit winkelwagen verwijderd`,
    cartCodeNotApplied: (code: string) => `De code ${code} van je winkelwagen geldt hier niet.`,
    recoAddLabel: (name: string, price: string) => `${name} toevoegen aan je bestelling, ${price}`,
    recoAdded: (name: string) => `${name} toegevoegd aan je bestelling`,
    localEstimate: (amount: string, currency: string) => `Je betaalt in ${currency}; indicatief bedrag ≈ ${amount} (ECB-koers, het eindbedrag hangt af van je bank)`,
    chargedIn: (amount: string, currency: string) => `Er wordt ${amount} afgeschreven (${currency}-prijs omgerekend tegen de ECB-referentiekoers van vandaag)`,
    volumeNudge: (n: number, pct: string) => `Nog ${n} artikel${n > 1 ? "en" : ""} voor −${pct}%`,
    volumeAddOne: (name: string) => `1 ${name} toevoegen`,
    volumeApplied: (pct: string) => `Staffelkorting −${pct}% toegepast`,
    volumeRow: (pct: string) => `Staffelkorting (−${pct}%)`,
    dealAmountUnit: (amount: string) => `−${amount} per artikel`,
    dealAmountBundle: (amount: string, n: number) => `−${amount} per ${n} stuks`,
    dealPrice: (n: number, amount: string) => `${n} voor ${amount}`,
    dealBxgy: (buy: number, free: number) => `${buy} kopen, ${free} gratis`,
    volumeNudgeDeal: (n: number, deal: string) => `Nog ${n} artikel${n > 1 ? "en" : ""} voor „${deal}”`,
    volumeAppliedDeal: (deal: string) => `„${deal}” toegepast`,
    volumeRowDeal: (deal: string) => `Staffelaanbod (${deal})`,
    claimEmailHint: (masked: string) => `Besteld met ${masked} — bevestig dit e-mailadres.`,
    claimPhotosCount: (n: number, max: number) => `${n}/${max} ${n === 1 ? "foto" : "foto's"}`,
    claimPhotoRemove: (i: number) => `Foto ${i} verwijderen`,
    claimPhotoPreview: (i: number) => `Foto ${i}`,
    pickupFound: (n: number) => `${n} afhaalpunt${n > 1 ? "en" : ""} gevonden`,
    pickupDeliveredAt: (name: string) => `Levering bij ${name}`,
    emailSuggest: (email: string) => `Bedoelde je ${email}?`,
    errZipFor: (country: string, example: string) => `Ongeldige postcode voor ${country} (bijv. ${example})`,
    offerValidFor: (min: number) => `Aanbod nog ${min} min geldig`,
    continueAs: (email: string) => `Doorgaan als ${email}`,
    giftNudgeAmount: (amount: string, gift: string) => `Nog ${amount} voor ${gift} gratis`,
    giftNudgeItems: (n: number, gift: string) => `Nog ${n} artikel${n > 1 ? "en" : ""} voor ${gift} gratis`,
    giftEarned: (gift: string) => `${gift} gratis bij je bestelling`,
    upsellOff: (pct: string) => `−${pct}%`,
  },
};

export type LabelFns = (typeof LABEL_FNS)["fr"];

/** The page's texts in `lang`: its plain texts (from the server) and the formulas. */
export function labelsOf<T extends object>(text: T, lang: Lang): T & LabelFns {
  return { ...text, ...(LABEL_FNS[lang] ?? LABEL_FNS.fr) };
}
