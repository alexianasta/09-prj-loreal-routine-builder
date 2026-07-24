/* Get references to DOM elements */
const categoryFilter = document.getElementById("categoryFilter");
const productSearchInput = document.getElementById("productSearch");
const productsContainer = document.getElementById("productsContainer");
const chatForm = document.getElementById("chatForm");
const chatWindow = document.getElementById("chatWindow");
const selectedProductsList = document.getElementById("selectedProductsList");
const clearSelectionsButton = document.getElementById("clearSelections");
const generateRoutineButton = document.getElementById("generateRoutine");
const userInput = document.getElementById("userInput");

/* Replace this with your class Cloudflare Worker URL */
const WORKER_URL = "https://wandering-fog-abc3.alenasta.workers.dev/";

/* If your Worker supports web search, keep this true */
const WEB_SEARCH_ENABLED = true;
const WEB_SEARCH_MODEL = "gpt-4.1";

/* This array stores the full chat history for follow-up questions */
let messages = [];
let allProducts = [];
let selectedCategory = "";
let searchQuery = "";

/* localStorage key used to persist selected products */
const SELECTED_PRODUCTS_STORAGE_KEY = "lorealSelectedProducts";

/* Keep selected products in a map so we can toggle quickly by name */
const selectedProducts = new Map();

/* Save selected products so they persist after page reload */
function saveSelectedProductsToStorage() {
  const productsToSave = Array.from(selectedProducts.values());
  localStorage.setItem(
    SELECTED_PRODUCTS_STORAGE_KEY,
    JSON.stringify(productsToSave),
  );
}

/* Load any previously selected products from localStorage */
function loadSelectedProductsFromStorage() {
  const rawSavedProducts = localStorage.getItem(SELECTED_PRODUCTS_STORAGE_KEY);

  if (!rawSavedProducts) {
    return;
  }

  try {
    const savedProducts = JSON.parse(rawSavedProducts);

    if (!Array.isArray(savedProducts)) {
      return;
    }

    savedProducts.forEach((product) => {
      if (product && typeof product.name === "string") {
        selectedProducts.set(product.name, product);
      }
    });
  } catch (error) {
    console.error("Could not read saved products from localStorage.", error);
  }
}

/* Update selected style for cards that are currently visible */
function syncVisibleCardSelectionState() {
  const visibleCards = productsContainer.querySelectorAll(".product-card");

  visibleCards.forEach((card) => {
    const productName = card.dataset.productName;

    if (selectedProducts.has(productName)) {
      card.classList.add("selected");
      return;
    }

    card.classList.remove("selected");
  });
}

/* Show initial placeholder until user selects a category */
productsContainer.innerHTML = `
  <div class="placeholder-message">
    Start typing or choose a category to browse products
  </div>
`;

/* Load product data from JSON file */
async function loadProducts() {
  if (allProducts.length > 0) {
    return allProducts;
  }

  const response = await fetch("products.json");
  const data = await response.json();
  allProducts = data.products;
  return allProducts;
}

/* Escape search text to lowercase for case-insensitive matching */
function normalizeText(value) {
  return String(value || "").toLowerCase();
}

/* Apply category + search filters together */
function applyProductFilters() {
  let filteredProducts = [...allProducts];

  if (selectedCategory) {
    filteredProducts = filteredProducts.filter(
      (product) => product.category === selectedCategory,
    );
  }

  if (searchQuery) {
    filteredProducts = filteredProducts.filter((product) => {
      const searchableText = [
        product.name,
        product.brand,
        product.category,
        product.description,
      ]
        .map((value) => normalizeText(value))
        .join(" ");

      return searchableText.includes(searchQuery);
    });
  }

  if (!selectedCategory && !searchQuery) {
    productsContainer.innerHTML = `
      <div class="placeholder-message">
        Start typing or choose a category to browse products
      </div>
    `;
    return;
  }

  if (filteredProducts.length === 0) {
    productsContainer.innerHTML = `
      <div class="placeholder-message">
        No products match your current filters
      </div>
    `;
    return;
  }

  displayProducts(filteredProducts);
}

/* Build a safe product payload with only the fields we need */
function buildSelectedProductPayload() {
  return Array.from(selectedProducts.values()).map((product) => ({
    name: product.name,
    brand: product.brand,
    category: product.category,
    description: product.description,
  }));
}

/* Escape text before inserting into HTML */
function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/* Turn plain URLs into clickable links in chat messages */
function linkifyText(text) {
  const escapedText = escapeHtml(text);
  const urlPattern = /(https?:\/\/[^\s]+)/g;

  return escapedText.replace(
    urlPattern,
    '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>',
  );
}

/* Create a formatted chat message and add it to the chat window */
function appendChatMessage(role, text, citations = []) {
  const wrapper = document.createElement("div");
  wrapper.className = `chat-message ${role}`;

  const label = document.createElement("p");
  label.className = "chat-message-label";
  label.textContent = role === "assistant" ? "AI Advisor" : "You";

  const body = document.createElement("p");
  body.className = "chat-message-text";
  body.innerHTML = linkifyText(text);

  wrapper.appendChild(label);
  wrapper.appendChild(body);

  if (citations.length > 0) {
    const sourcesTitle = document.createElement("p");
    sourcesTitle.className = "chat-citations-title";
    sourcesTitle.textContent = "Sources";

    const sourcesList = document.createElement("ul");
    sourcesList.className = "chat-citations-list";

    citations.forEach((citation) => {
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.href = citation.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = citation.title || citation.url;
      item.appendChild(link);
      sourcesList.appendChild(item);
    });

    wrapper.appendChild(sourcesTitle);
    wrapper.appendChild(sourcesList);
  }

  chatWindow.appendChild(wrapper);

  /* Keep the latest message visible */
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

/* Show a loading indicator while the AI response is being generated */
function showLoadingMessage() {
  const loadingMessage = document.createElement("div");
  loadingMessage.className = "chat-message assistant chat-loading";
  loadingMessage.id = "chatLoadingMessage";
  loadingMessage.textContent = "Building your routine...";
  chatWindow.appendChild(loadingMessage);
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

function removeLoadingMessage() {
  const loadingMessage = document.getElementById("chatLoadingMessage");
  if (loadingMessage) {
    loadingMessage.remove();
  }
}

/* Parse backend errors into readable messages */
async function parseErrorMessage(response) {
  try {
    const errorData = await response.json();
    return (
      errorData?.error?.message ||
      errorData?.message ||
      `Request failed with status ${response.status}`
    );
  } catch {
    return `Request failed with status ${response.status}`;
  }
}

/* Send one request to the Worker and return parsed JSON */
async function sendWorkerRequest(requestBody) {
  const response = await fetch(WORKER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const message = await parseErrorMessage(response);
    throw new Error(message);
  }

  return response.json();
}

/* Pull source links from multiple possible API response shapes */
function extractCitations(data) {
  const citations = [];

  const addCitation = (title, url) => {
    if (!url || typeof url !== "string") {
      return;
    }

    const alreadyExists = citations.some((citation) => citation.url === url);

    if (!alreadyExists) {
      citations.push({
        title: title || url,
        url,
      });
    }
  };

  /* Chat Completions annotations */
  const messageAnnotations = data?.choices?.[0]?.message?.annotations || [];
  messageAnnotations.forEach((annotation) => {
    addCitation(annotation?.title, annotation?.url);
  });

  /* Worker-level citations array */
  const workerCitations = data?.citations || [];
  workerCitations.forEach((citation) => {
    addCitation(citation?.title, citation?.url);
  });

  /* Responses API annotations */
  const responseOutput = data?.output || [];
  responseOutput.forEach((item) => {
    const content = item?.content || [];

    content.forEach((contentItem) => {
      const annotations = contentItem?.annotations || [];

      annotations.forEach((annotation) => {
        const annotationUrl =
          annotation?.url || annotation?.source?.url || annotation?.link;
        const annotationTitle =
          annotation?.title || annotation?.source?.title || annotation?.text;
        addCitation(annotationTitle, annotationUrl);
      });
    });
  });

  return citations;
}

/* Send messages to the class Cloudflare Worker */
async function getAIReply(currentMessages) {
  const classicRequestBody = {
    messages: currentMessages,
  };

  let data;

  /* Try web-search mode first, then fall back to classic mode for compatibility */
  if (WEB_SEARCH_ENABLED) {
    try {
      data = await sendWorkerRequest({
        ...classicRequestBody,
        model: WEB_SEARCH_MODEL,
        tools: [{ type: "web_search" }],
      });
    } catch (webSearchError) {
      data = await sendWorkerRequest(classicRequestBody).catch(
        (classicError) => {
          throw new Error(
            `Web-search request failed: ${webSearchError.message}. Classic fallback failed: ${classicError.message}.`,
          );
        },
      );
    }
  } else {
    data = await sendWorkerRequest(classicRequestBody);
  }

  /* Supports both Chat Completions and Responses-style payloads */
  const workerText = data?.text;
  const chatCompletionsText = data?.choices?.[0]?.message?.content;
  const responsesApiText = data?.output_text;
  const responsesOutputText = (data?.output || [])
    .flatMap((item) => item?.content || [])
    .filter((contentItem) => typeof contentItem?.text === "string")
    .map((contentItem) => contentItem.text)
    .join("\n")
    .trim();

  const aiReply =
    typeof workerText === "string" && workerText.trim() !== ""
      ? workerText
      : typeof chatCompletionsText === "string" &&
          chatCompletionsText.trim() !== ""
        ? chatCompletionsText
        : typeof responsesApiText === "string" && responsesApiText.trim() !== ""
          ? responsesApiText
          : responsesOutputText;

  if (typeof aiReply !== "string" || aiReply.trim() === "") {
    throw new Error("Worker returned an unexpected response format.");
  }

  const citations = extractCitations(data);

  return {
    text: aiReply,
    citations,
  };
}

/* Render selected products below the grid */
function renderSelectedProducts() {
  if (selectedProducts.size === 0) {
    selectedProductsList.innerHTML =
      '<p class="selected-placeholder">No products selected yet</p>';
    clearSelectionsButton.disabled = true;
    return;
  }

  selectedProductsList.innerHTML = Array.from(selectedProducts.values())
    .map(
      (product) => `
      <div class="selected-item">
        <span class="selected-item-name">${product.name}</span>
        <button
          type="button"
          class="remove-selected-btn"
          data-product-name="${product.name}"
          aria-label="Remove ${product.name}"
        >
          <i class="fa-solid fa-xmark" aria-hidden="true"></i>
        </button>
      </div>
    `,
    )
    .join("");

  clearSelectionsButton.disabled = false;
}

/* Create HTML for displaying product cards */
function displayProducts(products) {
  productsContainer.innerHTML = products
    .map(
      (product) => `
    <div class="product-card ${selectedProducts.has(product.name) ? "selected" : ""}" data-product-name="${product.name}">
      <img src="${product.image}" alt="${product.name}">
      <div class="product-info">
        <h3>${product.name}</h3>
        <p>${product.brand}</p>
      </div>
      <div class="product-hover-description">
        ${product.description}
      </div>
    </div>
  `,
    )
    .join("");
}

/* Toggle selection when a product card is clicked */
productsContainer.addEventListener("click", async (e) => {
  const clickedCard = e.target.closest(".product-card");

  if (!clickedCard) {
    return;
  }

  const productName = clickedCard.dataset.productName;

  /* If it's already selected, remove it */
  if (selectedProducts.has(productName)) {
    selectedProducts.delete(productName);
    clickedCard.classList.remove("selected");
    saveSelectedProductsToStorage();
    renderSelectedProducts();
    return;
  }

  /* Otherwise, find the product in the loaded catalog and add it */
  await loadProducts();
  const clickedProduct = allProducts.find(
    (product) => product.name === productName,
  );

  if (!clickedProduct) {
    return;
  }

  selectedProducts.set(clickedProduct.name, clickedProduct);
  clickedCard.classList.add("selected");
  saveSelectedProductsToStorage();
  renderSelectedProducts();
});

/* Remove one selected product using the remove button in the selected list */
selectedProductsList.addEventListener("click", (e) => {
  const removeButton = e.target.closest(".remove-selected-btn");

  if (!removeButton) {
    return;
  }

  const productName = removeButton.dataset.productName;
  selectedProducts.delete(productName);
  saveSelectedProductsToStorage();
  renderSelectedProducts();
  syncVisibleCardSelectionState();
});

/* Clear all selected products at once */
clearSelectionsButton.addEventListener("click", () => {
  selectedProducts.clear();
  saveSelectedProductsToStorage();
  renderSelectedProducts();
  syncVisibleCardSelectionState();
});

/* Filter and display products when category changes */
categoryFilter.addEventListener("change", async (e) => {
  await loadProducts();
  selectedCategory = e.target.value;
  applyProductFilters();
});

/* Filter products live as user types in the search box */
productSearchInput.addEventListener("input", async (e) => {
  await loadProducts();
  searchQuery = normalizeText(e.target.value.trim());
  applyProductFilters();
});

/* Generate a new routine using only selected products */
generateRoutineButton.addEventListener("click", async () => {
  const selectedProductPayload = buildSelectedProductPayload();

  if (selectedProductPayload.length === 0) {
    appendChatMessage(
      "assistant",
      "Please select at least one product before generating a routine.",
    );
    return;
  }

  if (WORKER_URL.includes("your-subdomain")) {
    appendChatMessage(
      "assistant",
      "Please update WORKER_URL in script.js with your class Cloudflare Worker URL.",
    );
    return;
  }

  /* Start a fresh routine conversation each time user clicks Generate Routine */
  messages = [
    {
      role: "system",
      content:
        "You are a L'Oréal skincare and beauty advisor. Create clear, practical routines using only the selected products. For follow-up questions, only answer topics related to the generated routine, skincare, haircare, makeup, fragrance, or closely related beauty topics. If a question is unrelated, politely refuse and guide the user back to routine/beauty questions. If web search is available, use it for current information and include links/citations in your answer.",
    },
    {
      role: "user",
      content: `Create a personalized routine using ONLY these selected products. Explain the order and when to use each one.${WEB_SEARCH_ENABLED ? " If possible, include any useful current references and source links." : ""}\n\nSelected products JSON:\n${JSON.stringify(
        selectedProductPayload,
        null,
        2,
      )}`,
    },
  ];

  chatWindow.innerHTML = "";
  showLoadingMessage();

  try {
    const aiReply = await getAIReply(messages);
    removeLoadingMessage();
    appendChatMessage("assistant", aiReply.text, aiReply.citations);

    /* Save assistant reply for follow-up context */
    messages.push({ role: "assistant", content: aiReply.text });
  } catch (error) {
    removeLoadingMessage();
    appendChatMessage(
      "assistant",
      `Something went wrong while generating your routine: ${error.message}`,
    );
    console.error(error);
  }
});

/* Show selected products placeholder on page load */
loadSelectedProductsFromStorage();
renderSelectedProducts();

/* Send follow-up questions using the same conversation history */
chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const userQuestion = userInput.value.trim();

  if (!userQuestion) {
    return;
  }

  if (messages.length === 0) {
    appendChatMessage(
      "assistant",
      "Generate a routine first, then ask follow-up questions here.",
    );
    return;
  }

  appendChatMessage("user", userQuestion);
  messages.push({ role: "user", content: userQuestion });
  userInput.value = "";
  showLoadingMessage();

  try {
    const aiReply = await getAIReply(messages);
    removeLoadingMessage();
    appendChatMessage("assistant", aiReply.text, aiReply.citations);
    messages.push({ role: "assistant", content: aiReply.text });
  } catch (error) {
    removeLoadingMessage();
    appendChatMessage(
      "assistant",
      `Something went wrong while answering your question: ${error.message}`,
    );
    console.error(error);
  }
});
