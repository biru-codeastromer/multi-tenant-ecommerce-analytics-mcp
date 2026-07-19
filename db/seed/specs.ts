/**
 * Seed specifications for five organizations across five verticals.
 *
 * The taxonomies are deliberately incompatible with each other. Every org
 * names its session-open event differently; three of them name it three
 * different things *within the same org*; one does not track search at all.
 * The canonical_name column is what makes a single question answerable across
 * all five, and these specs exist to prove it does.
 *
 * Deliberate data-quality problems planted here, each exercised by a test:
 *   - freshcart : mid-stream event rename (basket_add -> cart_add on day -45)
 *   - voltedge  : type conflict on `price` (number in some rows, string in others)
 *   - voltedge  : multi-currency orders (GBP / EUR / USD)
 *   - nordvik   : client clock skew (events dated 1970 and 2035)
 *   - nordvik   : an undocumented event appearing only in the last few days,
 *                 absent from the seeded registry, for the discovery job to find
 *   - nordvik   : late-arriving offline events (ingested days after event_time)
 *   - nordvik   : a deprecated event that stopped firing ~7 months ago
 *   - aurelia   : deliberately tiny dataset, and no search event whatsoever
 *   - bazaarhub : offline kiosk/POS channel, 30% RTO, delivered-only order metric
 *   - all       : PII (email/phone) planted in properties, for the masking policy
 */

export type CanonicalName =
  | 'session_start'
  | 'product_view'
  | 'search'
  | 'add_to_cart'
  | 'checkout_start'
  | 'order_complete'
  | 'order_status_change';

export interface EventSpec {
  name: string;
  canonical: CanonicalName | null;
  category: 'lifecycle' | 'discovery' | 'commerce' | 'engagement';
  displayName: string;
  /** Human-written. The discovery job must never overwrite these. */
  description: string | null;
  /** Relative share of this org's volume. Not normalised; weights are relative. */
  weight: number;
  platforms?: string[];
  /** Omitted from the seeded registry so the discovery job has to find it. */
  omitFromRegistry?: boolean;
  qualityNote?: string;
  /** Days-ago window in which this event fires at all. */
  activeFrom?: number;
  activeUntil?: number;
}

export interface OrgSpec {
  slug: string;
  name: string;
  vertical: string;
  timezone: string;
  currency: string;
  currencies?: string[];
  platforms: string[];
  cities: string[];
  acquisitionSources: string[];
  categories: string[];
  brands: string[];
  targetEvents: number;
  /** Fraction of sessions reaching each funnel stage. Never uniform. */
  funnel: { productView: number; addToCart: number; checkout: number; order: number };
  /** Terminal order status distribution. Must sum to 1. */
  statusMix: Record<string, number>;
  events: EventSpec[];
  /** Order-status semantics that differ from the global default. */
  metricOverride?: {
    metricKey: string;
    displayName: string;
    description: string;
    notes: string;
    statuses: string[];
  };
  notes: string;
}

const COMMON_SOURCES = ['organic', 'paid_search', 'social', 'referral', 'email', 'direct'];

export const ORG_SPECS: OrgSpec[] = [
  // =========================================================================
  // 1. Fashion — mobile-first, India. The "reference" taxonomy.
  // =========================================================================
  {
    slug: 'nordvik-fashion',
    name: 'Nordvik Fashion',
    vertical: 'fashion',
    timezone: 'Asia/Kolkata',
    currency: 'INR',
    platforms: ['ios', 'android', 'web'],
    cities: ['Mumbai', 'Delhi', 'Bengaluru', 'Jaipur', 'Pune', 'Kolkata'],
    acquisitionSources: COMMON_SOURCES,
    categories: ['dresses', 'tops', 'denim', 'footwear', 'accessories', 'outerwear'],
    brands: ['Nordvik', 'Halden', 'Ostra', 'Bryn', 'Ferro'],
    targetEvents: 4600,
    funnel: { productView: 0.62, addToCart: 0.21, checkout: 0.11, order: 0.058 },
    statusMix: { placed: 0.06, paid: 0.09, shipped: 0.12, delivered: 0.62, cancelled: 0.07, returned: 0.04 },
    notes:
      'Mobile-first Indian fashion retailer. Fires app_open on every foreground resume, so sessions_started reads high relative to unique_sessions — this is real and documented rather than smoothed away.',
    events: [
      {
        name: 'app_open',
        canonical: 'session_start',
        category: 'lifecycle',
        displayName: 'App Opened',
        description:
          'Fired on cold start AND on every foreground resume. Use unique_sessions rather than sessions_started for a deduplicated session count.',
        weight: 30,
      },
      {
        name: 'product_viewed',
        canonical: 'product_view',
        category: 'discovery',
        displayName: 'Product Viewed',
        description: 'Product detail page opened. Carries product_id, category, brand, size and colour.',
        weight: 26,
      },
      {
        name: 'search_performed',
        canonical: 'search',
        category: 'discovery',
        displayName: 'Search Performed',
        description: 'In-app search. `results_count` is 0 for null-result searches, which is the useful signal here.',
        weight: 14,
      },
      {
        name: 'added_to_bag',
        canonical: 'add_to_cart',
        category: 'commerce',
        displayName: 'Added to Bag',
        description: 'Item added to the shopping bag. Note the name: this org says "bag", not "cart".',
        weight: 10,
      },
      {
        name: 'checkout_started',
        canonical: 'checkout_start',
        category: 'commerce',
        displayName: 'Checkout Started',
        description: 'User entered the checkout flow.',
        weight: 6,
      },
      {
        name: 'order_placed',
        canonical: 'order_complete',
        category: 'commerce',
        displayName: 'Order Placed',
        description: 'Order submitted. Carries order_id, order_value_minor (paise), items[] and channel.',
        weight: 4,
      },
      {
        name: 'order_status_changed',
        canonical: 'order_status_change',
        category: 'commerce',
        displayName: 'Order Status Changed',
        description: 'Fulfilment status transition. The projection takes the latest status per order_id.',
        weight: 5,
      },
      {
        name: 'wishlist_added',
        canonical: null,
        category: 'engagement',
        displayName: 'Wishlist Added',
        description: 'Saved for later. No canonical mapping — wishlisting is not a cart add.',
        weight: 4,
      },
      // Stopped firing ~7 months ago. Present in the registry, must be pruned
      // from the generated context by last_seen_at.
      {
        name: 'push_notification_opened',
        canonical: null,
        category: 'engagement',
        displayName: 'Push Notification Opened',
        description: 'Legacy push SDK. Replaced by the new provider in January; retained for historical queries.',
        weight: 3,
        activeFrom: 260,
        activeUntil: 205,
      },
      // Not in the seeded registry at all. The discovery job must find it,
      // auto-register it, and mark it undocumented.
      {
        name: 'story_viewed',
        canonical: null,
        category: 'engagement',
        displayName: 'Story Viewed',
        description: null,
        weight: 5,
        omitFromRegistry: true,
        activeFrom: 6,
        activeUntil: 0,
      },
    ],
  },

  // =========================================================================
  // 2. Grocery — web-heavy, high repeat rate, mid-stream event rename.
  // =========================================================================
  {
    slug: 'freshcart-grocery',
    name: 'FreshCart Grocery',
    vertical: 'grocery',
    timezone: 'Asia/Kolkata',
    currency: 'INR',
    platforms: ['web', 'android'],
    cities: ['Hyderabad', 'Chennai', 'Bengaluru', 'Mumbai', 'Ahmedabad'],
    acquisitionSources: COMMON_SOURCES,
    categories: ['produce', 'dairy', 'staples', 'snacks', 'beverages', 'household'],
    brands: ['FreshCart', 'Amul', 'Tata', 'Britannia', 'Nestle'],
    targetEvents: 3900,
    // Grocery converts far better than fashion and browses far less.
    funnel: { productView: 0.44, addToCart: 0.38, checkout: 0.26, order: 0.19 },
    statusMix: { placed: 0.04, paid: 0.06, shipped: 0.05, delivered: 0.79, cancelled: 0.06 },
    notes:
      'Grocery: high conversion, low browse depth, strong weekly seasonality. Renamed basket_add to cart_add on day -45 without a backfill — both names appear in the history and the registry documents the seam.',
    events: [
      {
        name: 'website_open',
        canonical: 'session_start',
        category: 'lifecycle',
        displayName: 'Website Opened',
        description: 'Session start. This org is web-first; there is no app_open event.',
        weight: 28,
      },
      {
        name: 'sku_view',
        canonical: 'product_view',
        category: 'discovery',
        displayName: 'SKU Viewed',
        description: 'Product detail viewed. SKU-level, so one row per pack size.',
        weight: 20,
      },
      {
        name: 'catalog_search',
        canonical: 'search',
        category: 'discovery',
        displayName: 'Catalog Search',
        description: 'Catalogue search with typeahead. Fires on submit only, not per keystroke.',
        weight: 13,
      },
      {
        name: 'basket_add',
        canonical: 'add_to_cart',
        category: 'commerce',
        displayName: 'Basket Add (legacy)',
        description:
          'DEPRECATED. The original add-to-cart event. Renamed to cart_add on 2026-06-05 with no backfill.',
        weight: 12,
        activeFrom: 90,
        activeUntil: 45,
        qualityNote:
          'RENAME SEAM: renamed to cart_add on day -45. Any add-to-cart analysis spanning that date must include BOTH names or it will show a false cliff. The add_to_cart canonical mapping covers both, so query_metric handles this automatically.',
      },
      {
        name: 'cart_add',
        canonical: 'add_to_cart',
        category: 'commerce',
        displayName: 'Cart Add',
        description: 'Current add-to-cart event. Replaced basket_add on 2026-06-05.',
        weight: 12,
        activeFrom: 45,
        activeUntil: 0,
        qualityNote: 'Replaced basket_add on day -45. History before that date lives under the old name.',
      },
      {
        name: 'slot_selected',
        canonical: null,
        category: 'commerce',
        displayName: 'Delivery Slot Selected',
        description: 'Delivery window chosen. Grocery-specific; no equivalent in other verticals.',
        weight: 8,
      },
      {
        name: 'checkout_begin',
        canonical: 'checkout_start',
        category: 'commerce',
        displayName: 'Checkout Begun',
        description: 'Entered checkout.',
        weight: 7,
      },
      {
        name: 'purchase',
        canonical: 'order_complete',
        category: 'commerce',
        displayName: 'Purchase',
        description: 'Order confirmed. Note: named `purchase`, not `order_placed`.',
        weight: 6,
      },
      {
        name: 'order_status_changed',
        canonical: 'order_status_change',
        category: 'commerce',
        displayName: 'Order Status Changed',
        description: 'Fulfilment transition.',
        weight: 6,
      },
      {
        name: 'substitution_accepted',
        canonical: null,
        category: 'engagement',
        displayName: 'Substitution Accepted',
        description: 'Customer accepted a substitute for an out-of-stock item. Grocery-specific.',
        weight: 4,
      },
    ],
  },

  // =========================================================================
  // 3. Electronics — multi-currency, and a JSONB type conflict.
  // =========================================================================
  {
    slug: 'voltedge-electronics',
    name: 'VoltEdge Electronics',
    vertical: 'electronics',
    timezone: 'Europe/London',
    currency: 'GBP',
    currencies: ['GBP', 'EUR', 'USD'],
    platforms: ['web', 'ios', 'android'],
    cities: ['London', 'Manchester', 'Dublin', 'Berlin', 'Amsterdam', 'New York'],
    acquisitionSources: COMMON_SOURCES,
    categories: ['laptops', 'phones', 'audio', 'wearables', 'components', 'cameras'],
    brands: ['VoltEdge', 'Kestrel', 'Nimbus', 'Arclight'],
    targetEvents: 3600,
    // High-consideration purchases: deep browsing, low conversion.
    funnel: { productView: 0.71, addToCart: 0.14, checkout: 0.07, order: 0.031 },
    statusMix: { placed: 0.08, paid: 0.11, shipped: 0.14, delivered: 0.55, cancelled: 0.08, returned: 0.04 },
    notes:
      'Cross-border electronics selling in GBP, EUR and USD. Recognises revenue on delivery, not on order — hence the metric override. An SDK bug sends `price` as a string on web and a number on mobile.',
    metricOverride: {
      metricKey: 'orders_count',
      displayName: 'Orders (delivered)',
      description:
        'VoltEdge counts an order only once it has been DELIVERED. High-value electronics see meaningful pre-dispatch cancellation, so a placed order is a forecast, not a sale.',
      notes:
        'ORG-SPECIFIC: counts status = delivered only. This is intentionally narrower than the platform default (placed/paid/shipped/delivered) and will read lower than other orgs for the same underlying volume. Recent buckets under-count by design: orders placed in the last few days have not been delivered yet.',
      statuses: ['delivered'],
    },
    events: [
      {
        name: 'session_begin',
        canonical: 'session_start',
        category: 'lifecycle',
        displayName: 'Session Begin',
        description: 'Session start across web and mobile.',
        weight: 27,
      },
      {
        name: 'pdp_view',
        canonical: 'product_view',
        category: 'discovery',
        displayName: 'PDP View',
        description:
          'Product detail page view. WARNING: the `price` property is a string on web and a number on mobile — use jsonb_to_numeric(properties->\'price\') rather than a direct cast.',
        weight: 30,
      },
      {
        name: 'site_search',
        canonical: 'search',
        category: 'discovery',
        displayName: 'Site Search',
        description: 'Search over the catalogue.',
        weight: 12,
      },
      {
        name: 'spec_compared',
        canonical: null,
        category: 'discovery',
        displayName: 'Specs Compared',
        description: 'Side-by-side spec comparison. Strong purchase-intent signal in this vertical.',
        weight: 7,
      },
      {
        name: 'basket_add',
        canonical: 'add_to_cart',
        category: 'commerce',
        displayName: 'Basket Add',
        description:
          'Add to basket. Note: the same literal event name means add-to-cart here and a DEPRECATED name at FreshCart. Names are org-scoped.',
        weight: 8,
      },
      {
        name: 'checkout_step',
        canonical: 'checkout_start',
        category: 'commerce',
        displayName: 'Checkout Step',
        description: 'Fires once per checkout step; step number is in properties.step.',
        weight: 5,
      },
      {
        name: 'order_confirmed',
        canonical: 'order_complete',
        category: 'commerce',
        displayName: 'Order Confirmed',
        description: 'Order placed. Carries currency; this org transacts in GBP, EUR and USD.',
        weight: 4,
      },
      {
        name: 'order_status_changed',
        canonical: 'order_status_change',
        category: 'commerce',
        displayName: 'Order Status Changed',
        description: 'Fulfilment transition. Revenue is recognised at the delivered transition.',
        weight: 4,
      },
      {
        name: 'warranty_viewed',
        canonical: null,
        category: 'engagement',
        displayName: 'Warranty Viewed',
        description: 'Extended-warranty page viewed.',
        weight: 3,
      },
    ],
  },

  // =========================================================================
  // 4. D2C skincare — deliberately tiny, and tracks no search at all.
  // =========================================================================
  {
    slug: 'aurelia-skincare',
    name: 'Aurelia Skincare',
    vertical: 'd2c',
    timezone: 'America/New_York',
    currency: 'USD',
    platforms: ['ios', 'web'],
    cities: ['New York', 'Los Angeles', 'Austin', 'Chicago'],
    acquisitionSources: ['social', 'influencer', 'email', 'direct'],
    categories: ['serums', 'cleansers', 'moisturisers', 'sunscreen'],
    brands: ['Aurelia'],
    targetEvents: 320,
    funnel: { productView: 0.58, addToCart: 0.24, checkout: 0.15, order: 0.11 },
    statusMix: { placed: 0.1, paid: 0.14, delivered: 0.68, cancelled: 0.08 },
    notes:
      'Early-stage D2C brand: ~320 events total, and a catalogue of four products with no search functionality shipped yet. Exists to test sparse/empty result handling and the honest "this org does not track that" path — asking for search volume here must NOT return zero.',
    events: [
      {
        name: 'app_launch',
        canonical: 'session_start',
        category: 'lifecycle',
        displayName: 'App Launch',
        description: 'Session start.',
        weight: 30,
      },
      {
        name: 'product_detail',
        canonical: 'product_view',
        category: 'discovery',
        displayName: 'Product Detail Viewed',
        description: 'One of four SKUs viewed. There is no search event: the catalogue is four products on one screen.',
        weight: 26,
      },
      {
        name: 'bag_add',
        canonical: 'add_to_cart',
        category: 'commerce',
        displayName: 'Bag Add',
        description: 'Added to bag.',
        weight: 16,
      },
      {
        name: 'order_created',
        canonical: 'order_complete',
        category: 'commerce',
        displayName: 'Order Created',
        description: 'Order placed. Single-currency (USD).',
        weight: 12,
      },
      {
        name: 'order_status_changed',
        canonical: 'order_status_change',
        category: 'commerce',
        displayName: 'Order Status Changed',
        description: 'Fulfilment transition.',
        weight: 10,
      },
      {
        name: 'subscription_started',
        canonical: null,
        category: 'commerce',
        displayName: 'Subscription Started',
        description: 'Replenishment subscription created. D2C-specific.',
        weight: 6,
      },
    ],
  },

  // =========================================================================
  // 5. Marketplace — three session-open events, offline kiosk/POS, 30% RTO.
  // =========================================================================
  {
    slug: 'bazaarhub-marketplace',
    name: 'BazaarHub Marketplace',
    vertical: 'marketplace',
    timezone: 'Asia/Kolkata',
    currency: 'INR',
    platforms: ['ios', 'android', 'web', 'kiosk', 'pos'],
    cities: ['Jaipur', 'Lucknow', 'Indore', 'Surat', 'Nagpur', 'Patna', 'Kochi'],
    acquisitionSources: [...COMMON_SOURCES, 'offline_store'],
    categories: ['home', 'kitchen', 'apparel', 'electronics', 'toys', 'grocery'],
    brands: ['BazaarHub', 'Vihaan', 'Sundar', 'Meera', 'Kabir'],
    targetEvents: 4000,
    funnel: { productView: 0.53, addToCart: 0.19, checkout: 0.1, order: 0.062 },
    // 30% RTO: the whole reason this org redefines what an order is.
    statusMix: { placed: 0.07, paid: 0.05, shipped: 0.09, delivered: 0.45, cancelled: 0.04, rto_returned: 0.3 },
    notes:
      'Marketplace with online and offline (kiosk + in-store POS) channels. THREE distinct session-open events — app_open, website_open and kiosk_open — all mapping to session_start, which is the case that breaks any implementation assuming a one-to-one canonical mapping. 30% RTO drives the delivered-only order definition.',
    metricOverride: {
      metricKey: 'orders_count',
      displayName: 'Orders (delivered, net of RTO)',
      description:
        'BazaarHub counts an order only when it is DELIVERED. Roughly 30% of cash-on-delivery orders come back as RTO (return-to-origin), so counting placed orders overstates real volume by about a third.',
      notes:
        'ORG-SPECIFIC: counts status = delivered only, excluding rto_returned. This is why BazaarHub order counts look ~35% lower than a placed-order count for the same period. The gap is the RTO rate, not a data problem.',
      statuses: ['delivered'],
    },
    events: [
      {
        name: 'app_open',
        canonical: 'session_start',
        category: 'lifecycle',
        displayName: 'App Opened',
        description: 'Mobile app session start. One of THREE session-start events at this org.',
        weight: 14,
      },
      {
        name: 'website_open',
        canonical: 'session_start',
        category: 'lifecycle',
        displayName: 'Website Opened',
        description: 'Web session start. One of THREE session-start events at this org.',
        weight: 11,
      },
      {
        name: 'kiosk_open',
        canonical: 'session_start',
        category: 'lifecycle',
        displayName: 'Kiosk Session Started',
        description:
          'In-store kiosk session start. Offline channel: no acquisition_source, and user_id is set only if the shopper scans their loyalty card.',
        weight: 6,
      },
      {
        name: 'listing_view',
        canonical: 'product_view',
        category: 'discovery',
        displayName: 'Listing Viewed',
        description: 'Marketplace listing viewed. Carries seller_id in addition to product_id.',
        weight: 22,
      },
      {
        name: 'query_submitted',
        canonical: 'search',
        category: 'discovery',
        displayName: 'Search Query Submitted',
        description: 'Search submitted.',
        weight: 13,
      },
      {
        name: 'cart_item_added',
        canonical: 'add_to_cart',
        category: 'commerce',
        displayName: 'Cart Item Added',
        description: 'Added to cart.',
        weight: 9,
      },
      {
        name: 'checkout_opened',
        canonical: 'checkout_start',
        category: 'commerce',
        displayName: 'Checkout Opened',
        description: 'Entered checkout.',
        weight: 6,
      },
      {
        name: 'order_placed',
        canonical: 'order_complete',
        category: 'commerce',
        displayName: 'Order Placed',
        description: 'Online order placed. Mostly cash-on-delivery, which is what drives the RTO rate.',
        weight: 5,
      },
      {
        name: 'pos_sale',
        canonical: 'order_complete',
        category: 'commerce',
        displayName: 'In-Store POS Sale',
        description:
          'Offline point-of-sale transaction. Also maps to order_complete, so revenue and order counts include in-store sales. Never has a session_id.',
        weight: 4,
      },
      {
        name: 'order_status_changed',
        canonical: 'order_status_change',
        category: 'commerce',
        displayName: 'Order Status Changed',
        description: 'Fulfilment transition, including the rto_returned terminal state.',
        weight: 7,
      },
      {
        name: 'store_visit',
        canonical: null,
        category: 'engagement',
        displayName: 'Physical Store Visit',
        description: 'Loyalty card scanned at a physical store entrance. Offline-only.',
        weight: 3,
      },
    ],
  },
];
