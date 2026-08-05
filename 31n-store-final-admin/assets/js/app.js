(() => {
  "use strict";

  const DATA = window.N31_DATA;
  const products = DATA.products;
  const collections = DATA.collections;
  const CART_KEY = "31n_cart_v1";
  const ORDER_KEY = "31n_last_order";
  const PROMO_KEY = "31n_promo_v1";
  const PROMO_RATE = 0.30;
  const DELIVERY_RATE = Number(DATA.brand.deliveryRate || 0.03);
  const PROMO_CODE_UNITS = [77, 79, 72, 67, 89, 51, 48];
  let toastTimer;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const formatMoney = value => new Intl.NumberFormat("en-EG", { style: "currency", currency: DATA.brand.currency, maximumFractionDigits: 0 }).format(value);
  const getProduct = slug => products.find(product => product.slug === slug);
  const getCollection = slug => collections.find(collection => collection.slug === slug);
  const query = key => new URLSearchParams(location.search).get(key);
  const uniqueCategories = () => [...new Set(products.map(product => product.category))];
  const getDefaultColor = product => product.defaultColor || product.colors?.[0]?.name;
  const getMediaByColor = (product, color) => product.mediaByColor?.[color] || product.gallery || [product.image];
  const getPrimaryImage = (product, color) => getMediaByColor(product, color || getDefaultColor(product))[0] || product.image;
  const getCollectionName = slug => getCollection(slug)?.name || slug.replaceAll("-", " ");
  const productGalleryMarkup = (product, color) => getMediaByColor(product, color).map((image, index) => `<figure class="reveal is-visible"><img src="${image}" alt="${product.name}${index ? " detail" : ""}"></figure>`).join("");

  function getCart() {
    try { return JSON.parse(localStorage.getItem(CART_KEY)) || []; }
    catch { return []; }
  }

  function setCart(cart) {
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
    updateCartCount();
    renderCartDrawer();
  }

  function detailedCart() {
    return getCart().map(item => ({ ...item, product: getProduct(item.slug) })).filter(item => item.product);
  }

  function cartQuantity() {
    return getCart().reduce((total, item) => total + item.qty, 0);
  }

  function cartSubtotal() {
    return detailedCart().reduce((total, item) => total + item.product.price * item.qty, 0);
  }

  function normalizePromoCode(value = "") {
    return String(value).trim().toUpperCase();
  }

  function isValidPromoCode(value) {
    const normalized = normalizePromoCode(value);
    return normalized.length === PROMO_CODE_UNITS.length && [...normalized].every((char, index) => char.charCodeAt(0) === PROMO_CODE_UNITS[index]);
  }

  function getAppliedPromo() {
    try {
      const saved = JSON.parse(localStorage.getItem(PROMO_KEY));
      return saved && isValidPromoCode(saved.code) ? { code: normalizePromoCode(saved.code), rate: PROMO_RATE } : null;
    } catch { return null; }
  }

  function setAppliedPromo(code) {
    localStorage.setItem(PROMO_KEY, JSON.stringify({ code: normalizePromoCode(code) }));
  }

  function clearAppliedPromo() {
    localStorage.removeItem(PROMO_KEY);
  }

  function cartDiscount() {
    return getAppliedPromo() ? Math.round(cartSubtotal() * PROMO_RATE) : 0;
  }

  function cartMerchandiseTotal() {
    return Math.max(0, cartSubtotal() - cartDiscount());
  }

  function cartDelivery() {
    return Math.round(cartMerchandiseTotal() * DELIVERY_RATE);
  }

  function cartTotal() {
    return cartMerchandiseTotal() + cartDelivery();
  }

  function promoControlMarkup() {
    const promo = getAppliedPromo();
    return `<div class="promo-control">
      <div class="promo-control__label">Discount code</div>
      ${promo ? `<div class="promo-applied"><span>${promo.code} applied</span><button class="text-button" type="button" data-promo-remove>Remove</button></div>` : `<div class="promo-entry"><input type="text" inputmode="text" autocomplete="off" placeholder="Enter code" aria-label="Discount code" data-promo-input><button class="btn btn--compact" type="button" data-promo-apply>Apply</button></div><div class="promo-message" data-promo-message></div>`}
    </div>`;
  }

  function applyPromoCode(button) {
    const container = button.closest('.promo-control');
    const input = $('[data-promo-input]', container);
    const message = $('[data-promo-message]', container);
    const code = normalizePromoCode(input?.value);
    if (!isValidPromoCode(code)) {
      if (message) { message.textContent = "This discount code is not valid."; message.classList.add('is-visible'); }
      return;
    }
    setAppliedPromo(code);
    toast('Discount code applied');
    if (document.body.dataset.page === 'cart') renderCartPage();
    if (document.body.dataset.page === 'checkout') renderCheckoutSummary();
    renderCartDrawer();
  }

  function addToCart(slug, color, size, qty = 1) {
    const product = getProduct(slug);
    if (!product) return;
    const resolvedColor = color || product.colors[0].name;
    const resolvedSize = size || product.sizes[1] || product.sizes[0];
    const cart = getCart();
    const existing = cart.find(item => item.slug === slug && item.color === resolvedColor && item.size === resolvedSize);
    if (existing) existing.qty += qty;
    else cart.push({ slug, color: resolvedColor, size: resolvedSize, qty });
    setCart(cart);
    toast(`${product.shortName} added to cart`);
    openCartDrawer();
  }

  function updateQuantity(index, change) {
    const cart = getCart();
    if (!cart[index]) return;
    cart[index].qty += change;
    if (cart[index].qty <= 0) cart.splice(index, 1);
    setCart(cart);
    if (document.body.dataset.page === "cart") renderCartPage();
    if (document.body.dataset.page === "checkout") renderCheckoutSummary();
  }

  function removeCartItem(index) {
    const cart = getCart();
    cart.splice(index, 1);
    setCart(cart);
    if (document.body.dataset.page === "cart") renderCartPage();
    if (document.body.dataset.page === "checkout") renderCheckoutSummary();
  }

  function productCard(product) {
    const swatches = product.colors.map(color => `<span class="swatch" style="background:${color.hex}" title="${color.name}"></span>`).join("");
    return `
      <article class="product-card reveal">
        <div class="product-media">
          <span class="product-badge">${product.badge}</span>
          <a class="product-image-link" href="product.html?slug=${product.slug}" aria-label="View ${product.name}"><img src="${getPrimaryImage(product)}" alt="${product.name}" loading="lazy"></a>
          <button class="btn btn--wide quick-add" type="button" data-quick-add="${product.slug}">Quick add</button>
        </div>
        <div class="product-meta">
          <div>
            <a class="product-name" href="product.html?slug=${product.slug}">${product.name}</a>
            <div class="product-category">${product.category} / ${getCollectionName(product.collection)}</div>
            <div class="swatches">${swatches}</div>
          </div>
          <div class="product-price">${product.compareAt ? `<s>${formatMoney(product.compareAt)}</s>` : ""}${formatMoney(product.price)}</div>
        </div>
      </article>`;
  }

  function renderShell() {
    const page = document.body.dataset.page || "home";
    const active = name => page === name ? 'aria-current="page"' : "";
    document.body.insertAdjacentHTML("afterbegin", `
      <a class="skip-link" href="#main">Skip to content</a>
      <div class="announcement"><span>31°N — ALEXANDRIA, EGYPT &nbsp; / &nbsp; LIMITED DROPS &nbsp; / &nbsp; BUILT NORTH OF ORDINARY &nbsp; / &nbsp; 31°N — ALEXANDRIA, EGYPT</span></div>
      <header class="site-header">
        <div class="container nav">
          <div class="nav-links">
            <a class="nav-link" href="shop.html" ${active("shop")}>Shop</a>
            <a class="nav-link" href="collections.html" ${active("collections")}>Collections</a>
            <a class="nav-link" href="lookbook.html" ${active("lookbook")}>Lookbook</a>
          </div>
          <button class="icon-button menu-button" type="button" data-menu-toggle aria-label="Open menu">Menu</button>
          <a class="nav-logo" href="index.html" aria-label="31°N home"><img src="assets/images/31n-logo.png" alt="31°N"></a>
          <div class="nav-actions">
            <a class="nav-link" href="about.html" ${active("about")}>About</a>
            <button class="icon-button" type="button" data-cart-toggle>Cart <span class="cart-count">0</span></button>
          </div>
        </div>
      </header>
      <nav class="mobile-menu" aria-label="Mobile navigation">
        <a href="shop.html">Shop</a><a href="collections.html">Collections</a><a href="lookbook.html">Lookbook</a><a href="about.html">About</a><a href="contact.html">Contact</a>
      </nav>
      <div class="cursor-glow" aria-hidden="true"></div>
    `);

    document.body.insertAdjacentHTML("beforeend", `
      <footer class="site-footer">
        <div class="container">
          <div class="footer-grid">
            <div class="footer-brand"><img src="assets/images/31n-logo.png" alt="31°N"><p>Independent streetwear built at 31° north. Designed in Alexandria around conviction, movement and the beauty of being unfinished.</p></div>
            <div class="footer-col"><h3>Shop</h3><a href="shop.html">All products</a><a href="collections.html">Collections</a><a href="lookbook.html">Lookbook</a><a href="cart.html">Cart</a></div>
            <div class="footer-col"><h3>Help</h3><a href="faq.html">FAQ</a><a href="contact.html">Contact</a><a href="shipping.html">Shipping</a><a href="returns.html">Returns</a></div>
            <div class="footer-col"><h3>Legal</h3><a href="privacy.html">Privacy</a><a href="terms.html">Terms</a><a href="about.html">About 31°N</a></div>
          </div>
          <div class="footer-bottom"><span>© <span data-year></span> 31°N. All rights reserved.</span><span>Alexandria / 31.2001° N</span></div>
        </div>
      </footer>
      <div class="cart-drawer-backdrop" data-cart-backdrop>
        <aside class="cart-drawer" aria-label="Shopping cart">
          <div class="drawer-head"><h2>Your cart</h2><button class="icon-button" data-cart-close aria-label="Close cart">Close</button></div>
          <div class="drawer-body" data-drawer-body></div>
          <div class="drawer-foot" data-drawer-foot></div>
        </aside>
      </div>
      <div class="modal-backdrop" data-modal-backdrop><div class="modal" data-modal role="dialog" aria-modal="true"></div></div>
      <div class="toast" role="status" aria-live="polite"></div>
    `);
    $$('[data-year]').forEach(el => el.textContent = new Date().getFullYear());
    updateCartCount();
    renderCartDrawer();
  }

  function updateCartCount() {
    $$(".cart-count").forEach(el => el.textContent = cartQuantity());
  }

  function renderCartDrawer() {
    const body = $("[data-drawer-body]");
    const foot = $("[data-drawer-foot]");
    if (!body || !foot) return;
    const items = detailedCart();
    if (!items.length) {
      body.innerHTML = `<div class="empty-state" style="border:0"><h2>Cart is empty.</h2><p class="lede">Start with a piece from the current drop.</p><a class="btn" href="shop.html">Shop the drop</a></div>`;
      foot.innerHTML = "";
      return;
    }
    body.innerHTML = items.map((item, index) => `
      <div class="drawer-item">
        <img src="${getPrimaryImage(item.product, item.color)}" alt="${item.product.name}">
        <div><h3>${item.product.shortName}</h3><small class="cart-variant">${item.color} / ${item.size} / Qty ${item.qty}</small><br><button class="text-button" data-remove="${index}">Remove</button></div>
        <span>${formatMoney(item.product.price * item.qty)}</span>
      </div>`).join("");
    const discount = cartDiscount();
    foot.innerHTML = `<div class="drawer-total"><span>Subtotal</span><span>${formatMoney(cartSubtotal())}</span></div>${discount ? `<div class="drawer-total drawer-total--discount"><span>Discount</span><span>−${formatMoney(discount)}</span></div>` : ``}<div class="drawer-total"><span>Delivery (3%)</span><span>${formatMoney(cartDelivery())}</span></div><div class="drawer-total"><span>Total</span><strong>${formatMoney(cartTotal())}</strong></div><a class="btn btn--wide" href="cart.html">View cart</a>`;
  }

  function openCartDrawer() {
    $("[data-cart-backdrop]")?.classList.add("is-open");
    document.body.style.overflow = "hidden";
  }
  function closeCartDrawer() {
    $("[data-cart-backdrop]")?.classList.remove("is-open");
    document.body.style.overflow = "";
  }

  function toast(message) {
    const el = $(".toast");
    if (!el) return;
    el.textContent = message;
    el.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("is-visible"), 2200);
  }

  function modal(html) {
    const backdrop = $("[data-modal-backdrop]");
    const content = $("[data-modal]");
    content.innerHTML = html;
    backdrop.classList.add("is-open");
    document.body.style.overflow = "hidden";
  }
  function closeModal() {
    $("[data-modal-backdrop]")?.classList.remove("is-open");
    document.body.style.overflow = "";
  }

  function renderHome() {
    const main = $("#main");
    main.innerHTML = `
      <section class="hero">
        <div class="container hero-grid">
          <div class="hero-copy reveal">
            <div class="hero-kicker">Alexandria / 31.2001° N</div>
            <h1 class="display">Three collections.<br>One <em>direction.</em></h1>
            <p class="lede">31°N now presents Northbound 1.0, Alexandria is Rap and b31ieve basics — a wider catalog built around movement, imperfection and belief.</p>
            <div class="button-row"><a class="btn" href="shop.html">Shop all products</a><a class="btn btn--ghost" href="collections.html">Browse collections</a></div>
          </div>
          <div class="hero-art reveal">
            <div class="hero-coordinate">31°N</div>
            <div class="hero-card hero-card--one" data-parallax=".04"><img src="${getPrimaryImage(getProduct('fearless-acid-washed-tee'), 'Hunter Green')}" alt="Fearless tee in hunter green"></div>
            <div class="hero-card hero-card--two" data-parallax="-.03"><img src="${getPrimaryImage(getProduct('31n-gold-lap-sweatpants'), 'Black')}" alt="31°N gold lap sweatpants"></div>
            <div class="hero-index">Northbound / Alexandria / b31ieve</div>
          </div>
        </div>
      </section>
      <div class="ticker"><div class="ticker-track">${Array.from({length: 8}, () => `<span>NORTHBOUND 1.0 <b>✦</b> ALEXANDRIA IS RAP <b>✦</b> B31IEVE BASICS</span>`).join("")}</div></div>
      <section class="section">
        <div class="container">
          <div class="section-head reveal"><div><div class="eyebrow">Current catalog</div><h2>All live products.</h2></div><a class="btn btn--ghost" href="shop.html">Shop all</a></div>
          <div class="product-grid">${products.slice(0, 6).map(productCard).join("")}</div>
        </div>
      </section>
      <section class="manifesto section--green"><div class="giant">31° NORTH</div><p class="reveal">A coordinate can locate a city. A collection can locate a feeling.</p></section>
      <section class="section">
        <div class="container">
          <div class="section-head reveal"><div><div class="eyebrow">Three worlds / one label</div><h2>Explore the collections.</h2></div></div>
          <div class="collection-grid">${collections.map(collection => `
            <a class="collection-card reveal" href="collection.html?slug=${collection.slug}"><img src="${collection.image}" alt="${collection.name}" loading="lazy"><div class="collection-copy"><div class="eyebrow">${collection.eyebrow}</div><h3>${collection.name}</h3><p>${collection.copy}</p><p class="eyebrow" style="margin-top:14px">${collection.note || ''}</p></div></a>`).join("")}
          </div>
        </div>
      </section>
      <section class="editorial">
        <div class="editorial-media"><img src="${getPrimaryImage(getProduct('alexandria-is-rap-racore-edition'), 'Black')}" alt="Alexandria is Rap collection" loading="lazy"></div>
        <div class="editorial-copy"><div class="eyebrow">Limited-time drop</div><h2 class="editorial-title">Alexandria is Rap.</h2><p>This capsule is available until <strong>31 August</strong> and includes the Racore Edition tee, the Shehab x Abyu Special and the Gold Lap Sweatpants.</p><a class="btn btn--dark" href="collection.html?slug=alexandria-is-rap">Enter the capsule</a></div>
      </section>
      <section class="section section--paper">
        <div class="container newsletter reveal"><div><div class="eyebrow" style="color:#62625d">Private access</div><h2>Get the drop before it drops.</h2></div><div><p style="color:#62625d;line-height:1.7">Join for release dates, limited collection reminders and the b31ieve basics imagery update.</p><form class="newsletter-form" data-newsletter><input required type="email" placeholder="EMAIL ADDRESS" aria-label="Email address"><button>Join ↗</button></form></div></div>
      </section>`;
  }

  function renderShop() {
    const categories = uniqueCategories();
    const main = $("#main");
    main.innerHTML = `
      <section class="page-hero"><div class="container"><div class="eyebrow">31°N catalog / 3 collections</div><h1 class="page-title">Shop.</h1><div class="page-subhead"><p>Browse Northbound 1.0, Alexandria is Rap and b31ieve basics. Colour choices are connected directly to the uploaded product imagery where available.</p><span class="eyebrow"><span data-result-count>${products.length}</span> products</span></div></div></section>
      <section class="section"><div class="container"><div class="shop-toolbar"><div class="filter-group"><button class="filter-chip is-active" data-filter="all">All</button>${categories.map(category => `<button class="filter-chip" data-filter="${category}">${category}</button>`).join("")}</div><select data-sort aria-label="Sort products"><option value="featured">Featured</option><option value="price-low">Price: low to high</option><option value="price-high">Price: high to low</option><option value="name">Name</option></select></div><div class="product-grid" data-shop-grid>${products.map(productCard).join("")}</div></div></section>`;
  }

  function updateShopGrid() {
    const active = $(".filter-chip.is-active")?.dataset.filter || "all";
    const sort = $("[data-sort]")?.value || "featured";
    let list = products.filter(product => active === "all" || product.category === active);
    if (sort === "price-low") list = [...list].sort((a,b) => a.price - b.price);
    if (sort === "price-high") list = [...list].sort((a,b) => b.price - a.price);
    if (sort === "name") list = [...list].sort((a,b) => a.name.localeCompare(b.name));
    $("[data-shop-grid]").innerHTML = list.map(productCard).join("");
    $("[data-result-count]").textContent = list.length;
    initReveal();
  }

  function renderProduct() {
    const product = getProduct(query("slug")) || products[0];
    const collection = getCollection(product.collection);
    const defaultColor = getDefaultColor(product);
    document.title = `${product.name} — 31°N`;
    const main = $("#main");
    main.innerHTML = `
      <section><div class="container product-page">
        <div class="product-gallery" data-product-gallery>${productGalleryMarkup(product, defaultColor)}</div>
        <aside class="product-info reveal" data-product-info data-slug="${product.slug}">
          <div class="eyebrow">${collection ? collection.name : getCollectionName(product.collection)} / ${product.stock}</div>
          <h1>${product.name}</h1>
          <div class="price">${product.compareAt ? `<s>${formatMoney(product.compareAt)}</s>` : ""}<strong>${formatMoney(product.price)}</strong></div>
          <p class="product-description">${product.description}</p>
          ${collection?.note ? `<p class="eyebrow" style="margin:0 0 18px">${collection.note}</p>` : ``}
          <div class="option"><div class="option-head"><span>Colour</span><span data-color-label>${defaultColor}</span></div><div class="color-options">${product.colors.map(color => `<button class="option-button color-button ${color.name === defaultColor ? "is-selected" : ""}" data-color="${color.name}"><span class="color-dot" style="background:${color.hex}"></span>${color.name}</button>`).join("")}</div></div>
          <div class="option"><div class="option-head"><span>Size</span><a href="faq.html#sizing">Size guide</a></div><div class="size-options">${product.sizes.map((size,index) => `<button class="option-button ${index === 0 ? "is-selected" : ""}" data-size="${size}">${size}</button>`).join("")}</div></div>
          <div class="product-actions"><button class="btn btn--wide" data-add-product>Add to cart — ${formatMoney(product.price)}</button><button class="btn btn--ghost btn--wide" data-buy-now>Buy now</button></div>
          <div class="accordion"><details open><summary>Product details</summary><ul>${product.details.map(detail => `<li>${detail}</li>`).join("")}</ul></details><details><summary>Shipping & returns</summary><p>Delivery pricing and timing are calculated at checkout. Return rules can be edited in the included store policy pages.</p></details><details><summary>Care</summary><p>Wash inside out on a cool cycle. Do not iron directly over printed or embroidered areas. Air dry where possible.</p></details></div>
        </aside>
      </div></section>
      <section class="section section--paper"><div class="container"><div class="section-head"><div><div class="eyebrow" style="color:#62625d">You may also like</div><h2>Continue the direction.</h2></div></div><div class="product-grid">${products.filter(p => p.slug !== product.slug).slice(0, 6).map(productCard).join("")}</div></div></section>`;
  }


  function updateProductGallery(info, color) {
    const product = getProduct(info.dataset.slug);
    const gallery = info.closest('.product-page')?.querySelector('[data-product-gallery]');
    if (!product || !gallery) return;
    gallery.innerHTML = productGalleryMarkup(product, color);
    const label = $('[data-color-label]', info);
    if (label) label.textContent = color;
  }

  function renderCollections() {
    $("#main").innerHTML = `<section class="page-hero"><div class="container"><div class="eyebrow">The 31°N universe</div><h1 class="page-title">Collections.</h1><div class="page-subhead"><p>Northbound 1.0, Alexandria is Rap and b31ieve basics each carry a different state of mind.</p></div></div></section><section class="section"><div class="container"><div class="collection-grid">${collections.map(collection => `<a class="collection-card reveal" href="collection.html?slug=${collection.slug}"><img src="${collection.image}" alt="${collection.name}"><div class="collection-copy"><div class="eyebrow">${collection.eyebrow}</div><h3>${collection.name}</h3><p>${collection.copy}</p>${collection.note ? `<p class="eyebrow" style="margin-top:14px">${collection.note}</p>` : ``}</div></a>`).join("")}</div></div></section>`;
  }

  function renderCollection() {
    const collection = getCollection(query("slug")) || collections[0];
    const list = products.filter(product => product.collection === collection.slug);
    document.title = `${collection.name} — 31°N`;
    $("#main").innerHTML = `<section class="collection-hero"><img src="${collection.image}" alt="${collection.name}"><div class="container collection-hero-content"><div class="eyebrow">${collection.eyebrow}</div><h1>${collection.name}</h1><p>${collection.copy}</p>${collection.note ? `<p class="eyebrow" style="margin-top:16px">${collection.note}</p>` : ``}</div></section><section class="section"><div class="container"><div class="section-head"><div><div class="eyebrow">Collection pieces</div><h2>${list.length ? "The uniform." : "Coming north."}</h2></div></div><div class="product-grid">${list.map(productCard).join("") || `<div class="empty-state"><h2>Coming soon.</h2><p class="lede">This collection page is ready for its first product.</p></div>`}</div></div></section>`;
  }

  function renderLookbook() {
    const items = [
      [getPrimaryImage(getProduct('perfectly-flawed-tee'), 'Black'), 'Northbound 1.0', 'Signature'],
      [getPrimaryImage(getProduct('alexandria-is-rap-racore-edition'), 'Black'), 'Alexandria is Rap', 'Limited Drop'],
      [getPrimaryImage(getProduct('stitched-oversized-rebirth-tee'), 'Black'), 'b31ieve basics', 'Preview']
    ];
    $("#main").innerHTML = `<section class="page-hero"><div class="container"><div class="eyebrow">Campaign archive / 2026</div><h1 class="page-title">Lookbook.</h1><div class="page-subhead"><p>Updated collection studies from the new 31°N structure: Northbound 1.0, Alexandria is Rap and b31ieve basics.</p></div></div></section><section class="section"><div class="container"><div class="lookbook-grid">${items.map((item,index) => `<figure class="lookbook-item reveal"><img src="${item[0]}" alt="${item[1]}"><figcaption class="lookbook-caption"><span>0${index+1} / ${item[1]}</span><span>${item[2]}</span></figcaption></figure>`).join("")}</div></div></section>`;
  }

  function renderAbout() {
    $("#main").innerHTML = `<section class="page-hero"><div class="container"><div class="eyebrow">31.2001° N / 29.9187° E</div><h1 class="page-title">North is a mindset.</h1><div class="page-subhead"><p>31°N is an independent clothing label born in Alexandria, where the Mediterranean meets a city that never stops rebuilding itself.</p></div></div></section><section class="section"><div class="container content-grid"><h2 class="reveal">A coordinate turned into a uniform.</h2><div class="prose reveal"><p><strong>31°N takes its name from Alexandria’s latitude.</strong> The coordinate is literal, but the idea behind it is personal: north means forward, even when the route is not obvious.</p><p>The current store is built around <strong>three collections</strong>: <strong>Northbound 1.0</strong>, <strong>Alexandria is Rap</strong> and <strong>b31ieve basics</strong>. Each one carries a different emotional direction while staying inside the same visual language.</p><h3>Designed with restraint.</h3><p>Small front placements. Bigger statements where they matter. Heavy fabric, intentional colour systems and a product structure that can keep growing.</p><h3>Built to evolve.</h3><p>The site is data-driven, so future imagery — especially the final b31ieve basics assets — can be added without redesigning the whole store.</p></div></div></section><section class="editorial"><div class="editorial-media"><img src="${getPrimaryImage(getProduct('shehab-x-abyu-special-tee'), 'White')}" alt="Alexandria is Rap special tee"></div><div class="editorial-copy"><div class="eyebrow">The current focus</div><h2 class="editorial-title">Collections with story.</h2><p>Every product on 31°N sits inside a collection, so the store can read like a world instead of a list of disconnected items.</p><a class="btn btn--dark" href="collections.html">Explore the collections</a></div></section>`;
  }

  function renderContact() {
    $("#main").innerHTML = `<section class="page-hero"><div class="container"><div class="eyebrow">Customer care / Collaborations</div><h1 class="page-title">Contact.</h1><div class="page-subhead"><p>The form is ready to connect to your email service or backend endpoint.</p></div></div></section><section class="section"><div class="container contact-grid"><div class="contact-list"><div class="contact-item"><span>Based in</span>Alexandria, Egypt</div><div class="contact-item"><span>Customer care</span>hello@31n.example</div><div class="contact-item"><span>Instagram</span>@31n</div><p class="lede">Replace the sample email and social handle in <strong>assets/js/app.js</strong>.</p></div><form class="form-grid" data-contact-form><div class="field"><label for="name">Name</label><input id="name" required></div><div class="field"><label for="email">Email</label><input id="email" type="email" required></div><div class="field field--full"><label for="subject">Subject</label><select id="subject"><option>Order question</option><option>Product question</option><option>Collaboration</option><option>Other</option></select></div><div class="field field--full"><label for="message">Message</label><textarea id="message" required></textarea></div><div class="field field--full"><button class="btn" type="submit">Send message</button><div class="notice" data-contact-notice></div></div></form></div></section>`;
  }

  function renderFaq() {
    const faqs = [
      ["How does the fit run?", "The current products use an oversized or relaxed fit. Use your regular size for the intended silhouette, or size down for a closer fit."],
      ["What are the products made from?", "Material details are listed on every product page. The current catalog includes heavyweight cotton tees, boulevard cotton and cotton-fleece bottoms."],
      ["How is delivery calculated?", "A delivery charge equal to 3% of the merchandise total after any discount is shown in the cart and checkout before the order is placed."],
      ["How can I pay?", "The store currently accepts cash on delivery. Pay the displayed total to the courier when the order arrives."],
      ["Can I exchange a size?", "The returns page includes a starter policy. Replace the timing, condition and courier details with the rules your store will actually follow."],
      ["How should I wash printed pieces?", "Wash inside out on a cool cycle, avoid direct heat on graphics and air dry where possible."],
      ["How are orders managed?", "Orders are saved in the store's private SQLite database and can only be viewed by authenticated admins and couriers."]
    ];
    $("#main").innerHTML = `<section class="page-hero"><div class="container"><div class="eyebrow">Help centre</div><h1 class="page-title">FAQ.</h1></div></section><section class="section"><div class="container--narrow"><div class="faq-list" id="sizing">${faqs.map((faq,index) => `<details ${index === 0 ? "open" : ""}><summary>${faq[0]}</summary><p>${faq[1]}</p></details>`).join("")}</div></div></section>`;
  }

  function renderCartPage() {
    const main = $("#main");
    const items = detailedCart();
    const subtotal = cartSubtotal();
    const discount = cartDiscount();
    const delivery = cartDelivery();
    const total = cartTotal();
    main.innerHTML = `<section class="page-hero"><div class="container"><div class="eyebrow">Your selection</div><h1 class="page-title">Cart.</h1></div></section><section class="section"><div class="container">${items.length ? `<div class="cart-layout"><div class="cart-items">${items.map((item,index) => `<article class="cart-item"><a href="product.html?slug=${item.product.slug}"><img src="${getPrimaryImage(item.product, item.color)}" alt="${item.product.name}"></a><div><h3><a href="product.html?slug=${item.product.slug}">${item.product.name}</a></h3><div class="cart-variant">Colour: ${item.color}<br>Size: ${item.size}</div><div class="quantity"><button data-qty-minus="${index}" aria-label="Decrease quantity">−</button><span>${item.qty}</span><button data-qty-plus="${index}" aria-label="Increase quantity">+</button></div></div><div class="cart-line-total"><strong>${formatMoney(item.product.price * item.qty)}</strong><button class="text-button" data-remove="${index}">Remove</button></div></article>`).join("")}</div><aside class="summary-card"><h2>Order summary</h2><div class="summary-row"><span>Subtotal</span><span>${formatMoney(subtotal)}</span></div>${discount ? `<div class="summary-row summary-row--discount"><span>Discount</span><span>−${formatMoney(discount)}</span></div>` : ``}<div class="summary-row"><span>Delivery (3%)</span><span>${formatMoney(delivery)}</span></div><div class="summary-row summary-row--total"><span>Total</span><strong>${formatMoney(total)}</strong></div>${promoControlMarkup()}<p class="lede" style="font-size:12px">Delivery is calculated as 3% of the merchandise total after discounts.</p><a class="btn btn--wide" href="checkout.html">Checkout</a><a class="btn btn--ghost btn--wide" style="margin-top:10px" href="shop.html">Continue shopping</a></aside></div>` : `<div class="empty-state"><h2>Your cart is waiting.</h2><p class="lede">Add a piece from the current 31°N drop.</p><a class="btn" href="shop.html">Shop the drop</a></div>`}</div></section>`;
  }

  function renderCheckoutSummary() {
    const target = $("[data-checkout-summary]");
    if (!target) return;
    const items = detailedCart();
    const subtotal = cartSubtotal();
    const discount = cartDiscount();
    const delivery = cartDelivery();
    const total = cartTotal();
    target.innerHTML = `<h2>Order summary</h2>${items.map(item => `<div class="checkout-mini-item"><img src="${getPrimaryImage(item.product, item.color)}" alt="${item.product.name}"><div><h4>${item.product.shortName}</h4><small>${item.color} / ${item.size} / Qty ${item.qty}</small></div><span>${formatMoney(item.product.price * item.qty)}</span></div>`).join("")}<div class="summary-row"><span>Subtotal</span><span>${formatMoney(subtotal)}</span></div>${discount ? `<div class="summary-row summary-row--discount"><span>Discount</span><span>−${formatMoney(discount)}</span></div>` : ``}<div class="summary-row"><span>Delivery (3%)</span><span>${formatMoney(delivery)}</span></div><div class="summary-row summary-row--total"><span>Total</span><strong>${formatMoney(total)}</strong></div>${promoControlMarkup()}`;
  }

  function renderCheckout() {
    if (!getCart().length) { location.href = "cart.html"; return; }
    $("#main").innerHTML = `<section class="page-hero"><div class="container"><div class="eyebrow">Cash on delivery</div><h1 class="page-title">Checkout.</h1></div></section><section class="section"><div class="container checkout-layout"><form data-checkout-form><div class="checkout-block"><h2>Contact</h2><div class="form-grid"><div class="field field--full"><label>Email</label><input name="email" type="email" required autocomplete="email"></div><div class="field"><label>First name</label><input name="firstName" required autocomplete="given-name"></div><div class="field"><label>Last name</label><input name="lastName" required autocomplete="family-name"></div><div class="field"><label>Phone</label><input name="phone" required autocomplete="tel"></div></div></div><div class="checkout-block"><h2>Delivery</h2><div class="form-grid"><div class="field field--full"><label>Address</label><input name="address" required autocomplete="street-address"></div><div class="field"><label>City</label><input name="city" required value="Alexandria" autocomplete="address-level2"></div><div class="field"><label>Governorate</label><input name="governorate" required value="Alexandria" autocomplete="address-level1"></div><div class="field field--full"><label>Delivery notes</label><textarea name="notes" style="min-height:90px"></textarea></div></div><p class="checkout-note">Delivery is charged at 3% of the merchandise total after discounts.</p></div><div class="checkout-block"><h2>Payment</h2><div class="payment-options"><label class="payment-option"><input type="radio" name="paymentMethod" value="cod" checked disabled><span><strong>Cash on delivery</strong><small>Pay the full order total to the courier when your order arrives.</small></span></label></div></div><div class="checkout-block"><label style="display:flex;gap:10px;align-items:flex-start;color:var(--muted);line-height:1.5;font-size:12px"><input required type="checkbox" style="margin-top:3px"> I confirm the order details and agree to the store terms.</label></div><button class="btn btn--wide" type="submit">Place cash-on-delivery order</button><div class="notice notice--error" data-checkout-notice></div></form><aside class="summary-card" data-checkout-summary></aside></div></section>`;
    renderCheckoutSummary();
  }

  function renderNotFound() {
    $("#main").innerHTML = `<section class="confirmation"><div class="container--narrow"><div class="confirmation-mark">31</div><div class="eyebrow">404 / Off coordinate</div><h1>Wrong direction.</h1><p>The page you followed does not exist or has moved to a new coordinate.</p><div class="button-row" style="justify-content:center"><a class="btn" href="index.html">Return north</a><a class="btn btn--ghost" href="shop.html">Shop the drop</a></div></div></section>`;
  }

  function renderConfirmation() {
    const main = $("#main");
    let order = null;
    try { order = JSON.parse(localStorage.getItem(ORDER_KEY)); } catch {}
    if (order) {
      main.innerHTML = `<section class="confirmation"><div class="container--narrow"><div class="confirmation-mark">N</div><div class="eyebrow">Cash on delivery</div><h1>Direction confirmed.</h1><p>Order <strong>${order.id || "31°N"}</strong> has been received and is waiting for confirmation. Have the displayed total ready for the courier.</p>${order.total != null ? `<div class="confirmation-total">Order total <strong>${formatMoney(order.total)}</strong></div>` : ``}<div class="button-row" style="justify-content:center"><a class="btn" href="shop.html">Continue shopping</a><a class="btn btn--ghost" href="index.html">Home</a></div></div></section>`;
    } else {
      main.innerHTML = `<section class="confirmation"><div class="container--narrow"><div class="confirmation-mark">N</div><div class="eyebrow">Order status</div><h1>No order found.</h1><p>Return to the shop or contact support with your order reference.</p><div class="button-row" style="justify-content:center"><a class="btn" href="shop.html">Shop</a><a class="btn btn--ghost" href="contact.html">Contact</a></div></div></section>`;
    }
  }

  function renderPolicy(type) {
    const policies = {
      shipping: ["Shipping", "A delivery charge of 3% is calculated on the merchandise total after discounts and is displayed before checkout.", ["Cash-on-delivery orders use the 3% delivery calculation shown before the order is placed.", "Orders are prepared after the cash-on-delivery order is confirmed by staff.", "Delivery timing varies by destination and courier availability.", "Customers should receive tracking details when the order is dispatched.", "31°N is not responsible for delays caused by incomplete addresses or unsuccessful delivery attempts."]],
      returns: ["Returns & Exchanges", "This is a starter policy—not legal advice. Edit it to match your actual operations.", ["Items should be unworn, unwashed and returned with original packaging.", "Set a clear return window and state whether sale items are eligible.", "Specify who pays return shipping and how size exchanges are handled.", "Refunds should be issued to the original payment method after inspection."]],
      privacy: ["Privacy", "Describe exactly what data your store collects and which services receive it.", ["Customer details are used to process orders, provide support and prevent fraud.", "The store currently uses cash on delivery and does not collect card information.", "Analytics, email and advertising tools must be listed once connected.", "Customers should be given a way to request access, correction or deletion where applicable."]],
      terms: ["Terms", "These starter terms must be reviewed for your business and local requirements before launch.", ["Product colours can vary slightly by screen and production batch.", "Orders may be cancelled in cases of pricing error, unavailable stock or suspected fraud.", "Intellectual property on the site belongs to 31°N unless stated otherwise.", "Liability, governing law and dispute rules should be completed with qualified local guidance."]]
    };
    const [title, intro, points] = policies[type];
    $("#main").innerHTML = `<section class="page-hero"><div class="container"><div class="eyebrow">Store policy</div><h1 class="page-title">${title}.</h1><div class="page-subhead"><p>${intro}</p></div></div></section><section class="section"><div class="container--narrow prose"><p><strong>Last updated:</strong> August 2026</p>${points.map((point,index) => `<h3>0${index+1}</h3><p>${point}</p>`).join("")}</div></section>`;
  }

  function initReveal() {
    const elements = $$(".reveal:not(.is-visible)");
    if (!("IntersectionObserver" in window)) { elements.forEach(el => el.classList.add("is-visible")); return; }
    const observer = new IntersectionObserver(entries => entries.forEach(entry => { if (entry.isIntersecting) { entry.target.classList.add("is-visible"); observer.unobserve(entry.target); } }), { threshold: .12 });
    elements.forEach(el => observer.observe(el));
  }

  function bindGlobalEvents() {
    document.addEventListener("click", event => {
      const target = event.target.closest("button, a");
      if (!target) return;

      if (target.matches("[data-menu-toggle]")) {
        $(".mobile-menu").classList.toggle("is-open");
        document.body.style.overflow = $(".mobile-menu").classList.contains("is-open") ? "hidden" : "";
      }
      if (target.matches("[data-cart-toggle]")) openCartDrawer();
      if (target.matches("[data-cart-close]")) closeCartDrawer();
      if (target.matches("[data-cart-backdrop]") && target === event.target) closeCartDrawer();
      if (target.matches("[data-quick-add]")) { event.preventDefault(); addToCart(target.dataset.quickAdd); }
      if (target.matches("[data-remove]")) removeCartItem(Number(target.dataset.remove));
      if (target.matches("[data-qty-minus]")) updateQuantity(Number(target.dataset.qtyMinus), -1);
      if (target.matches("[data-qty-plus]")) updateQuantity(Number(target.dataset.qtyPlus), 1);
      if (target.matches("[data-filter]")) { $$("[data-filter]").forEach(button => button.classList.remove("is-active")); target.classList.add("is-active"); updateShopGrid(); }
      if (target.matches("[data-color]")) {
        const info = target.closest("[data-product-info]");
        $$('[data-color]', info).forEach(button => button.classList.remove('is-selected'));
        target.classList.add('is-selected');
        updateProductGallery(info, target.dataset.color);
      }
      if (target.matches("[data-size]")) {
        const info = target.closest("[data-product-info]") || document;
        $$('[data-size]', info).forEach(button => button.classList.remove('is-selected'));
        target.classList.add('is-selected');
      }
      if (target.matches("[data-add-product], [data-buy-now]")) {
        const info = target.closest("[data-product-info]");
        const color = $("[data-color].is-selected", info)?.dataset.color;
        const size = $("[data-size].is-selected", info)?.dataset.size;
        addToCart(info.dataset.slug, color, size);
        if (target.matches("[data-buy-now]")) location.href = "checkout.html";
      }
      if (target.matches("[data-modal-close]")) closeModal();
      if (target.matches("[data-promo-apply]")) applyPromoCode(target);
      if (target.matches("[data-promo-remove]")) {
        clearAppliedPromo();
        toast('Discount code removed');
        if (document.body.dataset.page === 'cart') renderCartPage();
        if (document.body.dataset.page === 'checkout') renderCheckoutSummary();
        renderCartDrawer();
      }
    });

    document.addEventListener("change", event => {
      if (event.target.matches("[data-sort]")) updateShopGrid();
    });
    document.addEventListener("submit", async event => {
      if (event.target.matches("[data-newsletter]")) { event.preventDefault(); event.target.reset(); toast("You are on the 31°N list"); }
      if (event.target.matches("[data-contact-form]")) { event.preventDefault(); const notice = $("[data-contact-notice]"); notice.textContent = "Form captured locally. Connect this form to your email service or backend endpoint before launch."; notice.classList.add("is-visible"); }
      if (event.target.matches("[data-checkout-form]")) { event.preventDefault(); await beginCheckout(event.target); }
    });

    $("[data-modal-backdrop]")?.addEventListener("click", event => { if (event.target === event.currentTarget) closeModal(); });
    document.addEventListener("keydown", event => { if (event.key === "Escape") { closeCartDrawer(); closeModal(); } });

    if (matchMedia("(pointer:fine)").matches) {
      const glow = $(".cursor-glow");
      addEventListener("pointermove", event => { glow.style.left = `${event.clientX}px`; glow.style.top = `${event.clientY}px`; });
    }

    addEventListener("scroll", () => {
      $$('[data-parallax]').forEach(el => { const amount = Number(el.dataset.parallax); el.style.translate = `0 ${scrollY * amount}px`; });
    }, { passive: true });
  }

  async function beginCheckout(form) {
    const notice = $("[data-checkout-notice]");
    const submit = $("button[type=submit]", form);
    submit.disabled = true;
    submit.textContent = "Placing order…";
    if (notice) { notice.textContent = ""; notice.classList.remove("is-visible"); }

    const customer = Object.fromEntries(new FormData(form).entries());
    delete customer.paymentMethod;
    const promo = getAppliedPromo();
    const payload = { customer, items: getCart(), promoCode: promo?.code || null, currency: DATA.brand.currency };
    try {
      const response = await fetch("/api/orders/cod", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || "The order could not be completed.");
      if (!result.order) throw new Error("The server did not return an order reference.");
      localStorage.setItem(ORDER_KEY, JSON.stringify(result.order));
      localStorage.removeItem(CART_KEY);
      localStorage.removeItem(PROMO_KEY);
      location.href = "order-confirmed.html";
    } catch (error) {
      if (notice) { notice.textContent = error.message; notice.classList.add("is-visible"); }
      submit.disabled = false;
      submit.textContent = "Place cash-on-delivery order";
    }
  }

  function renderPage() {
    const page = document.body.dataset.page;
    const map = {
      home: renderHome, shop: renderShop, product: renderProduct, collections: renderCollections,
      collection: renderCollection, lookbook: renderLookbook, about: renderAbout,
      contact: renderContact, faq: renderFaq, cart: renderCartPage, checkout: renderCheckout,
      confirmation: renderConfirmation, notfound: renderNotFound,
      shipping: () => renderPolicy("shipping"), returns: () => renderPolicy("returns"),
      privacy: () => renderPolicy("privacy"), terms: () => renderPolicy("terms")
    };
    (map[page] || renderHome)();
  }

  renderShell();
  renderPage();
  bindGlobalEvents();
  initReveal();
})();
