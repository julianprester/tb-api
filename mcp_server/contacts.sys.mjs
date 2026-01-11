/* exported contacts */
"use strict";

const MAX_RESULTS = 100;
const DEFAULT_LIMIT = 50;

/**
 * Find address book by ID or name
 */
function findAddressBook(idOrName, MailServices) {
  if (!idOrName) return null;
  
  for (const book of MailServices.ab.directories) {
    if (book.UID === idOrName || book.URI === idOrName || 
        book.dirName.toLowerCase() === idOrName.toLowerCase()) {
      return book;
    }
  }
  return null;
}

/**
 * List all address books
 */
export function listAddressBooks(MailServices) {
  const results = [];
  for (const book of MailServices.ab.directories) {
    results.push({
      id: book.UID,
      name: book.dirName,
      readOnly: book.readOnly,
    });
  }
  return { addressbooks: results };
}

/**
 * Search contacts with optional filters
 */
export function searchContacts(params, MailServices) {
  const { q, addressbook, limit = DEFAULT_LIMIT } = params;

  const results = [];
  const maxResults = Math.min(parseInt(limit, 10) || DEFAULT_LIMIT, MAX_RESULTS);
  const lowerQuery = q ? q.toLowerCase() : null;

  // Get address books to search
  let books;
  if (addressbook) {
    const book = findAddressBook(addressbook, MailServices);
    if (!book) {
      return { error: `Address book not found: ${addressbook}` };
    }
    books = [book];
  } else {
    books = Array.from(MailServices.ab.directories);
  }

  for (const book of books) {
    if (results.length >= maxResults) break;

    try {
      for (const card of book.childCards) {
        if (results.length >= maxResults) break;
        if (card.isMailList) continue;

        // Apply search filter
        if (lowerQuery) {
          const email = (card.primaryEmail || "").toLowerCase();
          const displayName = (card.displayName || "").toLowerCase();
          const firstName = (card.firstName || "").toLowerCase();
          const lastName = (card.lastName || "").toLowerCase();

          if (!email.includes(lowerQuery) &&
              !displayName.includes(lowerQuery) &&
              !firstName.includes(lowerQuery) &&
              !lastName.includes(lowerQuery)) {
            continue;
          }
        }

        results.push({
          id: card.UID,
          addressbook: book.UID,
          email: card.primaryEmail || null,
          displayName: card.displayName || null,
          firstName: card.firstName || null,
          lastName: card.lastName || null,
        });
      }
    } catch (e) {
      // Skip address books that fail
    }
  }

  return {
    contacts: results,
    total: results.length,
    has_more: results.length >= maxResults,
  };
}

/**
 * Create a new contact
 */
export function createContact(params, MailServices, Cc, Ci) {
  const { addressbook, email, displayName, firstName, lastName } = params;

  if (!addressbook) {
    return { error: "addressbook field is required" };
  }
  if (!email) {
    return { error: "email field is required" };
  }

  const book = findAddressBook(addressbook, MailServices);
  if (!book) {
    return { error: `Address book not found: ${addressbook}` };
  }
  if (book.readOnly) {
    return { error: "Address book is read-only" };
  }

  try {
    const card = Cc["@mozilla.org/addressbook/cardproperty;1"]
      .createInstance(Ci.nsIAbCard);

    card.primaryEmail = email;
    if (displayName) card.displayName = displayName;
    if (firstName) card.firstName = firstName;
    if (lastName) card.lastName = lastName;

    const newCard = book.addCard(card);

    return {
      success: true,
      message: "Contact created",
      id: newCard.UID,
    };
  } catch (e) {
    return { error: `Failed to create contact: ${e.message}` };
  }
}

/**
 * Update an existing contact
 */
export function updateContact(contactId, params, MailServices) {
  const { addressbook, email, displayName, firstName, lastName } = params;

  if (!addressbook) {
    return { error: "addressbook parameter is required" };
  }

  const book = findAddressBook(addressbook, MailServices);
  if (!book) {
    return { error: `Address book not found: ${addressbook}` };
  }
  if (book.readOnly) {
    return { error: "Address book is read-only" };
  }

  try {
    // Find the contact
    let card = null;
    for (const c of book.childCards) {
      if (c.UID === contactId) {
        card = c;
        break;
      }
    }

    if (!card) {
      return { error: `Contact not found: ${contactId}` };
    }

    // Update fields
    if (email !== undefined) card.primaryEmail = email;
    if (displayName !== undefined) card.displayName = displayName;
    if (firstName !== undefined) card.firstName = firstName;
    if (lastName !== undefined) card.lastName = lastName;

    book.modifyCard(card);

    return { success: true, message: "Contact updated" };
  } catch (e) {
    return { error: `Failed to update contact: ${e.message}` };
  }
}

/**
 * Delete a contact
 */
export function deleteContact(contactId, params, MailServices) {
  const { addressbook } = params;

  if (!addressbook) {
    return { error: "addressbook parameter is required" };
  }

  const book = findAddressBook(addressbook, MailServices);
  if (!book) {
    return { error: `Address book not found: ${addressbook}` };
  }
  if (book.readOnly) {
    return { error: "Address book is read-only" };
  }

  try {
    // Find the contact
    let card = null;
    for (const c of book.childCards) {
      if (c.UID === contactId) {
        card = c;
        break;
      }
    }

    if (!card) {
      return { error: `Contact not found: ${contactId}` };
    }

    book.deleteCards([card]);

    return { success: true, message: "Contact deleted" };
  } catch (e) {
    return { error: `Failed to delete contact: ${e.message}` };
  }
}
