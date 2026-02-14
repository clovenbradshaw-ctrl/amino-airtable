// Quick smoke test of the relational helper functions

function _rollupAggregate(values, aggName) {
    switch (aggName) {
        case 'SUM':
            return values.reduce(function(a, b) { return (a || 0) + (b || 0); }, 0);
        case 'MAX': {
            var nums = values.filter(function(v) { return typeof v === 'number'; });
            return nums.length ? Math.max.apply(null, nums) : null;
        }
        case 'MIN': {
            var nums = values.filter(function(v) { return typeof v === 'number'; });
            return nums.length ? Math.min.apply(null, nums) : null;
        }
        case 'AVERAGE': {
            var nums = values.filter(function(v) { return typeof v === 'number'; });
            return nums.length ? nums.reduce(function(a, b) { return a + b; }, 0) / nums.length : null;
        }
        case 'COUNT':
            return values.filter(function(v) { return typeof v === 'number'; }).length;
        case 'COUNTA':
            return values.filter(function(v) { return v != null && v !== ''; }).length;
        case 'COUNTALL':
            return values.length;
        case 'CONCATENATE':
        case 'ARRAYJOIN':
            return values.map(function(v) { return v != null ? String(v) : ''; }).join(', ');
        case 'ARRAYUNIQUE':
            var seen = {};
            return values.filter(function(v) {
                var k = String(v);
                if (seen[k]) return false;
                seen[k] = true;
                return true;
            });
        case 'ARRAYCOMPACT':
            return values.filter(function(v) { return v != null && v !== ''; });
        case 'AND':
            return values.every(Boolean);
        case 'OR':
            return values.some(Boolean);
        default:
            return values.join(', ');
    }
}

function _resolveLinkedIds(value) {
    if (!Array.isArray(value)) return [];
    return value.map(function(v) {
        if (typeof v === 'string') return v;
        if (v && typeof v === 'object' && v.id) return v.id;
        return null;
    }).filter(Boolean);
}

function _getLinkedRecordFields(linkedTableId, recordId) {
    // Simulated in-memory data
    var IN_MEMORY_DATA = {
        'tblLinked': {
            'rec1': { 'fldName': 'Alice', 'fldAge': 30 },
            'rec2': { 'fldName': 'Bob', 'fldAge': 25 },
            'rec3': { 'fldName': 'Charlie', 'fldAge': 35 }
        }
    };
    if (IN_MEMORY_DATA[linkedTableId] && IN_MEMORY_DATA[linkedTableId][recordId]) {
        return IN_MEMORY_DATA[linkedTableId][recordId];
    }
    return null;
}

// ── Tests ─────────────────────────────────────────────────

var passed = 0;
var failed = 0;

function assert(cond, msg) {
    if (cond) { passed++; }
    else { failed++; console.log('FAIL: ' + msg); }
}

// _rollupAggregate tests
assert(_rollupAggregate([1, 2, 3], 'SUM') === 6, 'SUM');
assert(_rollupAggregate([1, 5, 3], 'MAX') === 5, 'MAX');
assert(_rollupAggregate([1, 5, 3], 'MIN') === 1, 'MIN');
assert(_rollupAggregate([2, 4], 'AVERAGE') === 3, 'AVERAGE');
assert(_rollupAggregate([1, 'a', 3], 'COUNT') === 2, 'COUNT');
assert(_rollupAggregate([1, null, 3, ''], 'COUNTA') === 2, 'COUNTA');
assert(_rollupAggregate([1, 2, 3], 'COUNTALL') === 3, 'COUNTALL');
assert(_rollupAggregate(['a', 'b'], 'ARRAYJOIN') === 'a, b', 'ARRAYJOIN');
assert(JSON.stringify(_rollupAggregate([1, 1, 2], 'ARRAYUNIQUE')) === '[1,2]', 'ARRAYUNIQUE');
assert(JSON.stringify(_rollupAggregate([1, null, 2, ''], 'ARRAYCOMPACT')) === '[1,2]', 'ARRAYCOMPACT');
assert(_rollupAggregate([true, true], 'AND') === true, 'AND true');
assert(_rollupAggregate([true, false], 'AND') === false, 'AND false');
assert(_rollupAggregate([false, true], 'OR') === true, 'OR true');
assert(_rollupAggregate([false, false], 'OR') === false, 'OR false');
assert(_rollupAggregate([], 'SUM') === 0, 'SUM empty');
assert(_rollupAggregate([], 'MAX') === null, 'MAX empty');
assert(_rollupAggregate([], 'AVERAGE') === null, 'AVERAGE empty');

// _resolveLinkedIds tests
assert(JSON.stringify(_resolveLinkedIds(['rec1', 'rec2'])) === '["rec1","rec2"]', 'resolveLinkedIds strings');
assert(JSON.stringify(_resolveLinkedIds([{id: 'rec1'}, {id: 'rec2'}])) === '["rec1","rec2"]', 'resolveLinkedIds objects');
assert(JSON.stringify(_resolveLinkedIds('notarray')) === '[]', 'resolveLinkedIds non-array');
assert(JSON.stringify(_resolveLinkedIds(null)) === '[]', 'resolveLinkedIds null');
assert(JSON.stringify(_resolveLinkedIds([])) === '[]', 'resolveLinkedIds empty array');
assert(JSON.stringify(_resolveLinkedIds([null, 'rec1', undefined])) === '["rec1"]', 'resolveLinkedIds with nulls');

// _getLinkedRecordFields tests
var fields = _getLinkedRecordFields('tblLinked', 'rec1');
assert(fields !== null, 'getLinkedRecordFields found');
assert(fields.fldName === 'Alice', 'getLinkedRecordFields correct field');
assert(_getLinkedRecordFields('tblLinked', 'recNone') === null, 'getLinkedRecordFields missing record');
assert(_getLinkedRecordFields('tblNone', 'rec1') === null, 'getLinkedRecordFields missing table');

// Integration test: simulate count, lookup, rollup computation
var META_FIELDS = {
    'tblMain': {
        'fldLink': { fieldId: 'fldLink', fieldName: 'Linked', fieldType: 'multipleRecordLinks', options: { linkedTableId: 'tblLinked' } },
        'fldCount': { fieldId: 'fldCount', fieldName: 'Count', fieldType: 'count', options: { recordLinkFieldId: 'fldLink' } },
        'fldLookup': { fieldId: 'fldLookup', fieldName: 'Names', fieldType: 'lookup', options: { recordLinkFieldId: 'fldLink', fieldIdInLinkedTable: 'fldName' } },
        'fldRollup': { fieldId: 'fldRollup', fieldName: 'Total Age', fieldType: 'rollup', options: { recordLinkFieldId: 'fldLink', fieldIdInLinkedTable: 'fldAge', formula: 'SUM(values)' } }
    },
    'tblLinked': {
        'fldName': { fieldId: 'fldName', fieldName: 'Name', fieldType: 'singleLineText' },
        'fldAge': { fieldId: 'fldAge', fieldName: 'Age', fieldType: 'number' }
    }
};

var recordMap = {
    'recA': { 'fldLink': ['rec1', 'rec2'] },
    'recB': { 'fldLink': ['rec3'] },
    'recC': { 'fldLink': [] }
};

var fields = META_FIELDS['tblMain'];

// Simulate count computation
for (var rid in recordMap) {
    var row = recordMap[rid];
    var linkedIds = _resolveLinkedIds(row['fldLink']);
    row['fldCount'] = linkedIds.length;
}
assert(recordMap['recA']['fldCount'] === 2, 'Count recA = 2');
assert(recordMap['recB']['fldCount'] === 1, 'Count recB = 1');
assert(recordMap['recC']['fldCount'] === 0, 'Count recC = 0');

// Simulate lookup computation
for (var rid in recordMap) {
    var row = recordMap[rid];
    var linkedIds = _resolveLinkedIds(row['fldLink']);
    var values = [];
    for (var li = 0; li < linkedIds.length; li++) {
        var linkedFields = _getLinkedRecordFields('tblLinked', linkedIds[li]);
        if (linkedFields) values.push(linkedFields['fldName']);
    }
    row['fldLookup'] = values;
}
assert(JSON.stringify(recordMap['recA']['fldLookup']) === '["Alice","Bob"]', 'Lookup recA');
assert(JSON.stringify(recordMap['recB']['fldLookup']) === '["Charlie"]', 'Lookup recB');
assert(JSON.stringify(recordMap['recC']['fldLookup']) === '[]', 'Lookup recC');

// Simulate rollup computation
for (var rid in recordMap) {
    var row = recordMap[rid];
    var linkedIds = _resolveLinkedIds(row['fldLink']);
    var values = [];
    for (var li = 0; li < linkedIds.length; li++) {
        var linkedFields = _getLinkedRecordFields('tblLinked', linkedIds[li]);
        if (linkedFields) values.push(linkedFields['fldAge']);
    }
    row['fldRollup'] = _rollupAggregate(values, 'SUM');
}
assert(recordMap['recA']['fldRollup'] === 55, 'Rollup SUM recA = 55');
assert(recordMap['recB']['fldRollup'] === 35, 'Rollup SUM recB = 35');
assert(recordMap['recC']['fldRollup'] === 0, 'Rollup SUM recC = 0');

console.log('\n=== Relational Helper Results: ' + passed + ' passed, ' + failed + ' failed ===');
process.exit(failed > 0 ? 1 : 0);
