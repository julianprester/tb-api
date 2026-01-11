"use strict";

/**
 * Contacts operations using WebExtension APIs (MV3)
 * Uses messenger.addressBooks and messenger.addressBooks.contacts with vCard
 * Designed for LLM consumption with flexible inputs and helpful errors
 */

// Cache for address books (for suggestions)
let addressBookCache = null;

/**
 * Build vCard string from contact properties using ical.js
 */
function buildVCard(email, firstName, lastName, displayName) {
  const card = new ICAL.Component("vcard");
  card.addPropertyWithValue("version", "4.0");
  
  // FN (formatted name) is required
  const fn = displayName || [firstName, lastName].filter(Boolean).join(" ") || email;
  card.addPropertyWithValue("fn", fn);
  
  // N (structured name)
  if (firstName || lastName) {
    const n = card.addPropertyWithValue("n", [lastName || "", firstName || "", "", "", ""]);
  }
  
  // EMAIL
  if (email) {
    card.addPropertyWithValue("email", email);
  }
  
  return card.toString();
}

/**
 * Parse vCard string and extract properties using ical.js
 */
function parseVCard(vCardString) {
  try {
    const card = new ICAL.Component(ICAL.parse(vCardString));
    
    const fn = card.getFirstPropertyValue("fn");
    const email = card.getFirstPropertyValue("email");
    const n = card.getFirstPropertyValue("n");
    
    let firstName = null;
    let lastName = null;
    if (n && Array.isArray(n)) {
      lastName = n[0] || null;
      firstName = n[1] || null;
    }
    
    return {
      displayName: fn || null,
      email: email || null,
      firstName,
      lastName
    };
  } catch (e) {
    return { displayName: null, email: null, firstName: null, lastName: null };
  }
}

/**
 * List address books (also updates cache for suggestions)
 */
async function listAddressBooks() {
  const books = await messenger.addressBooks.list();
  
  // Update cache
  addressBookCache = books;
  
  return {
    addressbooks: books.map(book => ({
      id: book.id,
      name: book.name,
      readOnly: book.readOnly || false
    }))
  };
}

/**
 * Resolve address book with helpful suggestions on failure
 */
async function resolveAddressBookWithSuggestions(addressbook) {
  const books = addressBookCache || (await messenger.addressBooks.list());
  
  // Update cache if needed
  if (!addressBookCache) addressBookCache = books;
  
  const bookNames = books.map(b => b.name);
  const lower = addressbook.toLowerCase().trim();
  
  // Try exact ID match
  const byId = books.find(b => b.id === addressbook);
  if (byId) return { id: byId.id, name: byId.name, readOnly: byId.readOnly };
  
  // Try exact name match (case-insensitive)
  const byName = books.find(b => b.name.toLowerCase() === lower);
  if (byName) return { id: byName.id, name: byName.name, readOnly: byName.readOnly };
  
  // Try fuzzy match
  const fuzzyName = Utils.fuzzyMatch(addressbook, bookNames);
  if (fuzzyName) {
    const fuzzyBook = books.find(b => b.name === fuzzyName);
    if (fuzzyBook) return { id: fuzzyBook.id, name: fuzzyBook.name, readOnly: fuzzyBook.readOnly };
  }
  
  // Not found - provide helpful suggestions
  const suggestion = Utils.didYouMean(addressbook, bookNames);
  return {
    error: `Address book not found: "${addressbook}"`,
    suggestions: [
      suggestion,
      `Available address books: ${bookNames.join(", ")}`,
      "Use GET /addressbooks to see all available address books"
    ].filter(Boolean)
  };
}

/**
 * Search contacts with flexible parameters
 */
async function searchContacts(params) {
  // Normalize parameters
  const normalized = Utils.normalizeParams(params, Utils.PARAM_ALIASES);
  const { q, addressbook, limit = 50 } = normalized;
  const maxResults = Math.min(parseInt(limit, 10) || 50, 100);

  // Build query
  const queryInfo = {};
  if (q) queryInfo.searchString = q;
  
  // Resolve address book if specified
  if (addressbook) {
    const resolved = await resolveAddressBookWithSuggestions(addressbook);
    if (resolved.error) return resolved;
    queryInfo.parentId = resolved.id;
  }

  let contacts = await messenger.addressBooks.contacts.query(queryInfo);

  // Provide helpful feedback if no results
  if (contacts.length === 0) {
    const hints = [];
    if (q) hints.push(`No contacts match "${q}"`);
    if (addressbook) hints.push("Try searching in all address books (omit addressbook parameter)");
    
    return {
      contacts: [],
      total: 0,
      has_more: false,
      hints: hints.length > 0 ? hints : ["No contacts found"]
    };
  }

  const hasMore = contacts.length > maxResults;
  contacts = contacts.slice(0, maxResults);

  return {
    contacts: contacts.map(c => formatContact(c)),
    total: contacts.length,
    has_more: hasMore
  };
}

/**
 * Create contact with auto-recovery and helpful errors
 */
async function createContact(params) {
  // Normalize parameters
  const normalized = Utils.normalizeParams(params, Utils.PARAM_ALIASES);
  let { addressbook, email, firstName, lastName, displayName } = normalized;

  // Auto-select first writable address book if not specified
  if (!addressbook) {
    const books = addressBookCache || (await messenger.addressBooks.list());
    if (!addressBookCache) addressBookCache = books;
    
    const writableBooks = books.filter(b => !b.readOnly);
    if (writableBooks.length === 0) {
      return {
        error: "No writable address book available",
        suggestions: [
          "All address books are read-only",
          "Use GET /addressbooks to see available address books"
        ]
      };
    }
    addressbook = writableBooks[0].id;
  } else {
    // Resolve provided address book
    const resolved = await resolveAddressBookWithSuggestions(addressbook);
    if (resolved.error) return resolved;
    
    if (resolved.readOnly) {
      const books = addressBookCache || (await messenger.addressBooks.list());
      const writableBooks = books.filter(b => !b.readOnly);
      return {
        error: `Address book "${resolved.name}" is read-only`,
        suggestions: [
          writableBooks.length > 0 
            ? `Use a writable address book: ${writableBooks.map(b => b.name).join(", ")}`
            : "No writable address books available"
        ]
      };
    }
    
    addressbook = resolved.id;
  }

  if (!email) {
    return { 
      error: "Email address is required",
      suggestions: [
        'Provide an "email" field',
        'Example: POST /contacts {"email": "user@example.com", "firstName": "John", "lastName": "Doe"}'
      ]
    };
  }

  // Basic email validation
  if (!email.includes("@")) {
    return {
      error: `Invalid email address: "${email}"`,
      suggestions: ["Email must contain an @ symbol"]
    };
  }

  const vCard = buildVCard(email, firstName, lastName, displayName);

  try {
    const id = await messenger.addressBooks.contacts.create(addressbook, vCard);
    return { 
      success: true, 
      message: "Contact created", 
      id,
      contact: {
        email,
        firstName: firstName || null,
        lastName: lastName || null,
        displayName: displayName || [firstName, lastName].filter(Boolean).join(" ") || email
      }
    };
  } catch (e) {
    return { 
      error: `Failed to create contact: ${e.message}`,
      suggestions: [
        "Check that the email address is valid",
        "Verify the address book exists and is writable"
      ]
    };
  }
}

/**
 * Update contact with helpful errors
 */
async function updateContact(contactId, params) {
  // Normalize parameters
  const normalized = Utils.normalizeParams(params, Utils.PARAM_ALIASES);
  const { email, firstName, lastName, displayName } = normalized;

  try {
    const contact = await messenger.addressBooks.contacts.get(contactId);
    if (!contact) {
      return { 
        error: `Contact not found: ${contactId}`,
        suggestions: [
          "Use GET /contacts to find the correct contact ID",
          "The contact may have been deleted"
        ]
      };
    }

    // Parse existing vCard to get current values
    const existing = contact.vCard ? parseVCard(contact.vCard) : {};
    
    // Merge with updates
    const newEmail = email !== undefined ? email : existing.email || "";
    const newFirstName = firstName !== undefined ? firstName : existing.firstName || "";
    const newLastName = lastName !== undefined ? lastName : existing.lastName || "";
    const newDisplayName = displayName !== undefined ? displayName : existing.displayName || "";

    // Validate email if being updated
    if (email !== undefined && !email.includes("@")) {
      return {
        error: `Invalid email address: "${email}"`,
        suggestions: ["Email must contain an @ symbol"]
      };
    }

    const vCard = buildVCard(newEmail, newFirstName, newLastName, newDisplayName);
    await messenger.addressBooks.contacts.update(contactId, vCard);

    return { 
      success: true, 
      message: "Contact updated",
      contact: {
        email: newEmail,
        firstName: newFirstName || null,
        lastName: newLastName || null,
        displayName: newDisplayName || null
      }
    };
  } catch (e) {
    return { 
      error: `Failed to update contact: ${e.message}`,
      suggestions: [
        "Check that the contact ID is correct",
        "Use GET /contacts to find the correct contact"
      ]
    };
  }
}

/**
 * Delete contact with helpful errors
 */
async function deleteContact(contactId) {
  try {
    // First verify contact exists
    try {
      await messenger.addressBooks.contacts.get(contactId);
    } catch (e) {
      return {
        error: `Contact not found: ${contactId}`,
        suggestions: [
          "The contact may have already been deleted",
          "Use GET /contacts to find the correct contact ID"
        ]
      };
    }
    
    await messenger.addressBooks.contacts.delete(contactId);
    return { success: true, message: "Contact deleted" };
  } catch (e) {
    return { 
      error: `Failed to delete contact: ${e.message}`,
      suggestions: [
        "The contact may be in a read-only address book",
        "Check that the contact ID is correct"
      ]
    };
  }
}

// Helper functions

function formatContact(contact) {
  // MV3: ContactNode has vCard property instead of properties
  if (contact.vCard) {
    const parsed = parseVCard(contact.vCard);
    return {
      id: contact.id,
      addressbook: contact.parentId,
      email: parsed.email,
      displayName: parsed.displayName,
      firstName: parsed.firstName,
      lastName: parsed.lastName
    };
  }
  
  // Fallback for any remaining properties format
  const props = contact.properties || {};
  return {
    id: contact.id,
    addressbook: contact.parentId,
    email: props.PrimaryEmail || null,
    displayName: props.DisplayName || null,
    firstName: props.FirstName || null,
    lastName: props.LastName || null
  };
}

// Export
var Contacts = {
  listAddressBooks,
  searchContacts,
  createContact,
  updateContact,
  deleteContact
};
