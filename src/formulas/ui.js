/**
 * Formula UI Components
 *
 * Rendering helpers for computed/formula cells in the spreadsheet grid.
 * Handles cell rendering with epistemic status indicators, formula bar display,
 * and provenance panels.
 *
 * Epistemic Status Visual Indicators:
 *   GIVEN    — no indicator (user-entered data)
 *   DERIVED (formula) — purple dot
 *   DERIVED (lookup)  — blue dot
 *   DERIVED (rollup)  — amber dot
 */

/**
 * Format a computed cell value based on its result type.
 * Returns an HTML string suitable for insertion into a <td>.
 *
 * @param {any} value - The computed value
 * @param {object} compiledField - CompiledField descriptor
 * @param {function} esc - HTML escaping function
 * @returns {string} HTML string
 */
export function formatFormulaValue(value, compiledField, esc) {
  // Handle error values
  if (value && value.__error) {
    return '<span class="cell-formula-error" title="' + esc(value.message) + '">#ERROR</span>';
  }

  // Handle null/undefined
  if (value == null) {
    return '<span class="cell-empty">\u2014</span>';
  }

  const resultType = compiledField.resultType || {};

  switch (resultType.type) {
    case 'number': {
      const precision = resultType.options && resultType.options.precision;
      const formatted = precision != null ? Number(value).toFixed(precision) : String(value);
      return '<span class="cell-number">' + esc(formatted) + '</span>';
    }

    case 'currency': {
      const symbol = (resultType.options && resultType.options.symbol) || '$';
      const precision = (resultType.options && resultType.options.precision) || 2;
      return '<span class="cell-number">' + esc(symbol + Number(value).toFixed(precision)) + '</span>';
    }

    case 'percent': {
      const precision = (resultType.options && resultType.options.precision) || 0;
      return '<span class="cell-number">' + esc((Number(value) * 100).toFixed(precision) + '%') + '</span>';
    }

    case 'date':
    case 'dateTime': {
      if (value instanceof Date) {
        return esc(value.toLocaleDateString());
      }
      return esc(String(value));
    }

    default: {
      // Arrays (from lookups)
      if (Array.isArray(value)) {
        if (value.length === 0) return '<span class="cell-empty">\u2014</span>';
        return value.map(v => '<span class="tag">' + esc(String(v ?? '')) + '</span>').join('');
      }
      return esc(String(value));
    }
  }
}

/**
 * Get the CSS class for the epistemic status dot indicator.
 *
 * @param {'formula'|'lookup'|'rollup'|string} fieldType
 * @returns {string} CSS class name
 */
export function getEpistemicDotClass(fieldType) {
  switch (fieldType) {
    case 'formula':  return 'epistemic-dot-formula';
    case 'lookup':   return 'epistemic-dot-lookup';
    case 'rollup':   return 'epistemic-dot-rollup';
    default:         return 'epistemic-dot-formula';
  }
}

/**
 * Build HTML for the formula bar shown when a computed cell is selected.
 *
 * @param {object} compiledField - CompiledField descriptor
 * @param {function} esc - HTML escaping function
 * @returns {string} HTML string
 */
export function buildFormulaBarHTML(compiledField, esc) {
  const type = compiledField.fieldType;
  const badgeClass = type === 'lookup' ? 'badge-lookup'
                   : type === 'rollup' ? 'badge-rollup'
                   : 'badge-formula';

  const rawDef = compiledField.eoIR && compiledField.eoIR.grounding
    ? compiledField.eoIR.grounding.rawDefinition
    : '\u2014';

  return '<span class="formula-bar-badge ' + badgeClass + '">' + esc(type) + '</span>' +
         '<span class="formula-bar-text">' + esc(rawDef) + '</span>';
}

/**
 * Build HTML for the provenance panel that shows the full EO-IR chain.
 *
 * @param {object} compiledField - CompiledField descriptor
 * @param {function} esc - HTML escaping function
 * @returns {string} HTML string
 */
export function buildProvenanceHTML(compiledField, esc) {
  const eoIR = compiledField.eoIR;
  if (!eoIR) {
    return '<div class="provenance-empty">No provenance data available for this field.</div>';
  }

  let html = '';

  // Header
  html += '<div class="provenance-header">';
  html += '<h3>' + esc(compiledField.fieldName) + '</h3>';
  html += '<span class="formula-bar-badge badge-derived">DERIVED</span>';
  html += '</div>';

  // Formula section
  html += '<div class="provenance-section">';
  html += '<h4>Formula</h4>';
  html += '<code>' + esc(eoIR.grounding.rawDefinition) + '</code>';
  html += '</div>';

  // Source fields
  if (eoIR.sourceFields && eoIR.sourceFields.length > 0) {
    html += '<div class="provenance-section">';
    html += '<h4>Source Fields</h4>';
    html += '<ul class="provenance-source-fields">';
    for (const sf of eoIR.sourceFields) {
      const statusClass = sf.epistemicStatus === 'DERIVED' ? 'badge-derived' : 'badge-given';
      html += '<li>';
      html += '<span class="formula-bar-badge ' + statusClass + '">' + esc(sf.epistemicStatus) + '</span> ';
      html += esc(sf.fieldName);
      html += ' <small>(' + esc(sf.fieldId) + ')</small>';
      html += '</li>';
    }
    html += '</ul>';
    html += '</div>';
  }

  // Grounding
  html += '<div class="provenance-section">';
  html += '<h4>Grounding</h4>';
  html += '<dl class="provenance-grounding">';
  html += '<dt>Source</dt><dd>' + esc(eoIR.grounding.source) + '</dd>';
  html += '<dt>Captured</dt><dd>' + esc(eoIR.grounding.capturedAt) + '</dd>';
  html += '<dt>Schema</dt><dd>' + esc(eoIR.grounding.schemaVersion) + '</dd>';
  html += '</dl>';
  html += '</div>';

  // Operator chain
  if (eoIR.operators && eoIR.operators.length > 0) {
    html += '<div class="provenance-section">';
    html += '<h4>Operator Chain</h4>';
    html += '<ol class="provenance-op-chain">';
    for (const op of eoIR.operators) {
      html += '<li>';
      html += '<span class="op-badge op-' + op.op.toLowerCase() + '">' + esc(op.op) + '</span> ';
      html += '<span class="op-params">' + esc(JSON.stringify(op.params)) + '</span>';
      html += ' <small>\u2192 ' + esc(op.output) + '</small>';
      html += '</li>';
    }
    html += '</ol>';
    html += '</div>';
  }

  return html;
}
