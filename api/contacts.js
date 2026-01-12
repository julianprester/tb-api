"use strict";

/**
 * Contacts operations using WebExtension APIs (MV2)
 * Uses messenger.contacts API with properties format
 * Designed for LLM consumption with flexible inputs and helpful errors
 */

// Cache for address books (for suggestions)
let addressBookCache = null;

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
  const parsedLimit = parseInt(limit, 10);
  const maxResults = Math.min(Math.max(parsedLimit > 0 ? parsedLimit : 50, 1), 100);

  let contacts = [];

  // Get contacts from specific address book or all
  if (addressbook) {
    const resolved = await resolveAddressBookWithSuggestions(addressbook);
    if (resolved.error) return resolved;
    contacts = await messenger.contacts.list(resolved.id);
  } else {
    const books = addressBookCache || (await messenger.addressBooks.list());
    if (!addressBookCache) addressBookCache = books;
    
    for (const book of books) {
      const bookContacts = await messenger.contacts.list(book.id);
      contacts.push(...bookContacts);
    }
  }

  // Filter by query
  if (q) {
    const lower = q.toLowerCase();
    contacts = contacts.filter(c => {
      const props = c.properties || {};
      return (props.PrimaryEmail || "").toLowerCase().includes(lower) ||
             (props.DisplayName || "").toLowerCase().includes(lower) ||
             (props.FirstName || "").toLowerCase().includes(lower) ||
             (props.LastName || "").toLowerCase().includes(lower);
    });
  }

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

  // Build properties object (MV2 format)
  const properties = {
    PrimaryEmail: email
  };

  if (firstName) properties.FirstName = firstName;
  if (lastName) properties.LastName = lastName;
  if (displayName) {
    properties.DisplayName = displayName;
  } else if (firstName || lastName) {
    properties.DisplayName = [firstName, lastName].filter(Boolean).join(" ");
  } else {
    properties.DisplayName = email;
  }

  try {
    // MV2 API: messenger.contacts.create(parentId, id, properties)
    const id = await messenger.contacts.create(addressbook, null, properties);
    return { 
      success: true, 
      message: "Contact created", 
      id,
      contact: {
        email,
        firstName: firstName || null,
        lastName: lastName || null,
        displayName: properties.DisplayName
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
    const contact = await messenger.contacts.get(contactId);
    if (!contact) {
      return { 
        error: `Contact not found: ${contactId}`,
        suggestions: [
          "Use GET /contacts to find the correct contact ID",
          "The contact may have been deleted"
        ]
      };
    }

    // Validate email if being updated
    if (email !== undefined && !email.includes("@")) {
      return {
        error: `Invalid email address: "${email}"`,
        suggestions: ["Email must contain an @ symbol"]
      };
    }

    // Build properties object with updates (MV2 format)
    const properties = {};
    if (email !== undefined) properties.PrimaryEmail = email;
    if (firstName !== undefined) properties.FirstName = firstName;
    if (lastName !== undefined) properties.LastName = lastName;
    if (displayName !== undefined) properties.DisplayName = displayName;

    // MV2 API: messenger.contacts.update(id, properties)
    await messenger.contacts.update(contactId, properties);

    return { 
      success: true, 
      message: "Contact updated",
      contact: {
        email: email !== undefined ? email : (contact.properties?.PrimaryEmail || null),
        firstName: firstName !== undefined ? firstName : (contact.properties?.FirstName || null),
        lastName: lastName !== undefined ? lastName : (contact.properties?.LastName || null),
        displayName: displayName !== undefined ? displayName : (contact.properties?.DisplayName || null)
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
      await messenger.contacts.get(contactId);
    } catch (e) {
      return {
        error: `Contact not found: ${contactId}`,
        suggestions: [
          "The contact may have already been deleted",
          "Use GET /contacts to find the correct contact ID"
        ]
      };
    }
    
    await messenger.contacts.delete(contactId);
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
