import { spawn } from 'child_process';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import * as yaml from 'js-yaml';
import { tmpdir } from 'os';
import {
    CharmAction,
    CharmActionProblem,
    CharmActions,
    CharmAssumptions,
    CharmConfig,
    CharmConfigParameter,
    CharmConfigParameterProblem,
    CharmContainer,
    CharmContainerBase,
    CharmContainerMount,
    CharmDevice,
    CharmEndpoint,
    CharmExtraBinding,
    CharmMetadata,
    CharmMetadataProblem,
    CharmResource,
    CharmStorage,
    emptyMetadata,
    isConfigParameterType
} from './model/charm';
import { toValidSymbol } from './model/common';
import path = require('path');

function tryParseYAML(content: string): any {
    try {
        return yaml.load(content);
    } catch {
        return undefined;
    }
}


const _ACTION_PROBLEMS = {
    invalidYAMLFile: { message: "Invalid YAML file." },
    entryMustBeObject: (key: string) => ({ action: key, message: `Action entry \`${key}\` must be an object.` }),
    entryDescriptionMustBeValid: (key: string) => ({ action: key, message: `Description for action \`${key}\` should be a string.` }),
} satisfies Record<string, CharmActionProblem | ((...args: any[]) => CharmActionProblem)>;

export function parseCharmActionsYAML(content: string): CharmActions {
    const problems: CharmActionProblem[] = [];
    const doc = tryParseYAML(content);
    if (!doc || typeof doc !== 'object') {
        problems.push(_ACTION_PROBLEMS.invalidYAMLFile);
        return { actions: [], problems };
    }

    const actions: CharmAction[] = [];
    for (const [name, value] of Object.entries(doc)) {
        const entry: CharmAction = {
            name,
            symbol: toValidSymbol(name),
            problems: [],
        };
        actions.push(entry);

        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            entry.problems.push(_ACTION_PROBLEMS.entryMustBeObject(name));
            continue;
        }

        if ('description' in value) {
            if (typeof value['description'] !== 'string') {
                entry.problems.push(_ACTION_PROBLEMS.entryDescriptionMustBeValid(name));
            } else {
                entry.description = value.description;
            }
        }
    }

    return { actions, problems };
}

const _CONFIG_PROBLEMS = {
    invalidYAMLFile: { message: "Invalid YAML file." },
    optionsFieldMissing: { message: "Missing `options` field." },
    optionsFieldMustBeObject: { message: "The `options` field must be an object." },
    paramEntryMustBeObject: (key: string) => ({ parameter: key, message: `Parameter entry \`${key}\` must be an object.` }),
    paramEntryMustIncludeType: (key: string) => ({ parameter: key, message: `Parameter \`${key}\` must include \`type\` field.` }),
    paramEntryTypeMustBeValid: (key: string) => ({ parameter: key, message: `Parameter \`${key}\` must have a valid type; \`bool\`, \`string\`, \`int\`, or \`float\`.` }),
    paramEntryDefaultMustMatchTypeBoolean: (key: string) => ({ parameter: key, message: `Default value for parameter \`${key}\` should be a boolean value.` }),
    paramEntryDefaultMustMatchTypeString: (key: string) => ({ parameter: key, message: `Default value for parameter \`${key}\` should be a string value.` }),
    paramEntryDefaultMustMatchTypeInteger: (key: string) => ({ parameter: key, message: `Default value for parameter \`${key}\` should be an integer value.` }),
    paramEntryDefaultMustMatchTypeFloat: (key: string) => ({ parameter: key, message: `Default value for parameter \`${key}\` should be a float value.` }),
    paramEntryDefaultMustBeValid: // This happens when there'n no `type` field to restrict the default value type
        (key: string) => ({ parameter: key, message: `Default value for parameter \`${key}\` must have a valid type; boolean, string, integer, or float.` }),
    paramEntryDescriptionMustBeValid: (key: string) => ({ parameter: key, message: `Description for parameter \`${key}\` should be a string.` }),
} satisfies Record<string, CharmConfigParameterProblem | ((...args: any[]) => CharmConfigParameterProblem)>;

export function parseCharmConfigYAML(content: string): CharmConfig {
    const problems: CharmConfigParameterProblem[] = [];
    const doc = tryParseYAML(content);
    if (!doc || typeof doc !== 'object') {
        problems.push(_CONFIG_PROBLEMS.invalidYAMLFile);
        return { parameters: [], problems };
    }
    if (!('options' in doc)) {
        problems.push(_CONFIG_PROBLEMS.optionsFieldMissing);
        return { parameters: [], problems };
    }
    if (!doc['options'] || typeof doc['options'] !== 'object' || Array.isArray(doc['options'])) {
        problems.push(_CONFIG_PROBLEMS.optionsFieldMustBeObject);
        return { parameters: [], problems };
    }

    const parameters: CharmConfigParameter[] = [];
    for (const [name, value] of Object.entries(doc['options'])) {
        const entry: CharmConfigParameter = {
            name,
            problems: [],
        };
        parameters.push(entry);

        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            entry.problems.push(_CONFIG_PROBLEMS.paramEntryMustBeObject(name));
            continue;
        }

        if (!('type' in value)) {
            entry.problems.push(_CONFIG_PROBLEMS.paramEntryMustIncludeType(name));
        } else if (!value['type'] || typeof value['type'] !== 'string' || !isConfigParameterType(value['type'])) {
            entry.problems.push(_CONFIG_PROBLEMS.paramEntryTypeMustBeValid(name));
        } else {
            entry.type = value['type'];
        }

        if ('default' in value) {
            const defaultValue = value['default'];
            if (entry.type) {
                let problem: CharmConfigParameterProblem | undefined;

                if (entry.type === 'string' && typeof defaultValue !== 'string') {
                    problem = _CONFIG_PROBLEMS.paramEntryDefaultMustMatchTypeString(name);
                }
                else if (entry.type === 'boolean' && typeof defaultValue !== 'boolean') {
                    problem = _CONFIG_PROBLEMS.paramEntryDefaultMustMatchTypeBoolean(name);
                }
                else if (entry.type === 'int' && (typeof defaultValue !== 'number' || !Number.isInteger(defaultValue))) {
                    problem = _CONFIG_PROBLEMS.paramEntryDefaultMustMatchTypeInteger(name);
                }
                else if (entry.type === 'float' && typeof defaultValue !== 'number') {
                    problem = _CONFIG_PROBLEMS.paramEntryDefaultMustMatchTypeFloat(name);
                }

                if (problem) {
                    entry.problems.push(problem);
                } else if (defaultValue === undefined || typeof defaultValue === 'string' || typeof defaultValue === 'number' || typeof defaultValue === 'boolean') {
                    entry.default = defaultValue;
                }
            } else {
                // There's no valid type for the parameter, so we should check if the default value is not essentially invalid.
                if (!(typeof defaultValue === 'string' || typeof defaultValue === 'boolean' || typeof defaultValue === 'number')) {
                    entry.problems.push(_CONFIG_PROBLEMS.paramEntryDefaultMustBeValid(name));
                } else {
                    entry.default = defaultValue;
                }
            }
        }

        if ('description' in value) {
            if (typeof value['description'] !== 'string') {
                entry.problems.push(_CONFIG_PROBLEMS.paramEntryDescriptionMustBeValid(name));
            } else {
                entry.description = value['description'];
            }
        }
    }

    return { parameters, problems };
}

const _METADATA_PROBLEMS = {
    invalidYAMLFile: { message: "Invalid YAML file." },
    nameFieldMissing: { message: "Missing `name` field." },
    nameFieldInvalid: { key: 'name', message: "Value of `name` field should be a string." },
    displayNameFieldMissing: { message: "Missing `display-name` field." },
    displayNameFieldInvalid: { key: 'display-name', message: "Value of `display-name` field should be a string." },
    descriptionFieldMissing: { message: "Missing `description` field." },
    descriptionFieldInvalid: { key: 'description', message: "Value of `description` field should be a string." },
    summaryFieldMissing: { message: "Missing `summary` field." },
    summaryFieldInvalid: { key: 'summary', message: "Value of `summary` field should be a string." },
    sourceFieldInvalid: { key: 'source', message: "Value of `source` field should be a string or an array of strings." },
    issuesFieldInvalid: { key: 'issues', message: "Value of `issues` field should be a string or an array of strings." },
    websiteFieldInvalid: { key: 'website', message: "Value of `website` field should be a string or an array of strings." },
    maintainersFieldInvalid: { key: 'maintainers', message: "Value of `maintainers` field should be an array of strings." },
    tagsFieldInvalid: { key: 'tags', message: "Value of `tags` field should be an array of strings." },
    termsFieldInvalid: { key: 'terms', message: "Value of `terms` field should be an array of strings." },
    docsFieldInvalid: { key: 'docs', message: "Value of `docs` field should be a string." },
    subordinateFieldInvalid: { key: 'subordinate', message: "Value of `subordinate` field should be a boolean." },
    requiresFieldInvalid: { key: 'requires', message: "Value of `requires` field should be an object." },
    providesFieldInvalid: { key: 'provides', message: "Value of `provides` field should be an object." },
    peerFieldInvalid: { key: 'peers', message: "Value of `peers` field should be an object." },
    endpointEntryInvalid: (key: string) => ({ key, message: `Value of \`${key}\` field should be an object.` }),
    endpointInterfaceFieldMissing: (key: string) => ({ key, message: "Missing `interface` field." }),
    endpointInterfaceFieldInvalid: (key: string) => ({ key, message: "Value of `interface` field should be a string." }),
    endpointLimitFieldInvalid: (key: string) => ({ key, message: "Value of `limit` field should be an integer." }),
    endpointOptionalFieldInvalid: (key: string) => ({ key, message: "Value of `optional` field should be a boolean." }),
    endpointScopeFieldInvalid: (key: string) => ({ key, message: "Value of `scope` field should be either `global` or `container`." }),
    endpointFieldUnknown: (key: string, field: string) => ({ key, message: `Unknown field \`${field}\`` }),
    resourcesFieldInvalid: { key: 'resources', message: "Value of `resources` field should be an object." },
    resourceEntryInvalid: (key: string) => ({ key, message: `Value of \`${key}\` field should be an object.` }),
    resourceTypeFieldMissing: (key: string) => ({ key, message: "Missing `type` field." }),
    resourceTypeFieldInvalid: (key: string) => ({ key, message: "Value of `type` field should be either `file` or `oci-image`." }),
    resourceDescriptionFieldInvalid: (key: string) => ({ key, message: "Value of `description` field should be a string." }),
    resourceFilenameFieldMissing: (key: string) => ({ key, message: "Missing `filename` field." }),
    resourceFilenameFieldInvalid: (key: string) => ({ key, message: "Value of `filename` field should be a string." }),
    resourceFilenameFieldUnrelated: (key: string) => ({ key, message: "Unrelated `filename` field." }),
    devicesFieldInvalid: { key: 'devices', message: "Value of `devices` field should be an object." },
    deviceEntryInvalid: (key: string) => ({ key, message: `Value of \`${key}\` field should be an object.` }),
    deviceTypeFieldMissing: (key: string) => ({ key, message: "Missing `type` field." }),
    deviceTypeFieldInvalid: (key: string) => ({ key, message: "Value of `type` field should be either `gpu` or `nvidia.com/gpu` or `amd.com/gpu`." }),
    deviceDescriptionFieldInvalid: (key: string) => ({ key, message: "Value of `description` field should be a string." }),
    deviceCountMinFieldInvalid: (key: string) => ({ key, message: "Value of `countmin` field should be an integer." }),
    deviceCountMaxFieldInvalid: (key: string) => ({ key, message: "Value of `countmax` field should be an integer." }),
    storageFieldInvalid: { key: 'storage', message: "Value of `storage` field should be an object." },
    storageEntryInvalid: (key: string) => ({ key, message: `Value of \`${key}\` field should be an object.` }),
    storageTypeFieldMissing: (key: string) => ({ key, message: "Missing `type` field." }),
    storageTypeFieldInvalid: (key: string) => ({ key, message: "Value of `type` field should be either `filesystem` or `block`." }),
    storageDescriptionFieldInvalid: (key: string) => ({ key, message: "Value of `description` field should be a string." }),
    storageLocationFieldInvalid: (key: string) => ({ key, message: "Value of `location` field should be a string." }),
    storageSharedFieldInvalid: (key: string) => ({ key, message: "Value of `shared` field should be a boolean." }),
    storageReadOnlyFieldInvalid: (key: string) => ({ key, message: "Value of `read-only` field should be a boolean." }),
    storageMultipleFieldInvalid: (key: string) => ({ key, message: "Value of `multiple` field should be one of n, n+, n-, or n-m, where n and m are integers." }),
    storageMinimumSizeFieldInvalid: (key: string) => ({ key, message: "Value of `minimum-size` field should be either n or nM, where n is an integer and M is a either of these multipliers: M, G, T, P, E, Z or Y." }),
    storagePropertiesFieldInvalid: (key: string) => ({ key, message: "Value of `properties` field should be an array of string values; only 'transient' is allowed as array elements." }),
    extraBindingsFieldInvalid: { key: 'extra-bindings', message: "Value of `extra-bindings` field should be an object." },
    extraBindingEntryInvalid: (key: string) => ({ key, message: `Value of \`${key}\` field should be an object.` }),
    containersFieldInvalid: { key: 'containers', message: "Value of `containers` field should be an object." },
    containerEntryInvalid: (key: string) => ({ key, message: `Value of \`${key}\` field should be an object.` }),
    containerResourceFieldInvalid: (key: string) => ({ key, message: "Value of `resource` field should be a string." }),
    containerBasesFieldInvalid: (key: string) => ({ key, message: "Value of `bases` field should be an array of objects." }),
    containerBaseNameFieldMissing: (index: number) => ({ index, message: "Missing `name` field." }),
    containerBaseNameFieldInvalid: (index: number) => ({ index, message: "Value of `name` field should be a string." }),
    containerBaseChannelFieldMissing: (index: number) => ({ index, message: "Missing `channel` field." }),
    containerBaseChannelFieldInvalid: (index: number) => ({ index, message: "Value of `channel` field should be a string." }),
    containerBaseArchitecturesFieldMissing: (index: number) => ({ index, message: "Missing `architectures` field." }),
    containerBaseArchitecturesFieldInvalid: (index: number) => ({ index, message: "Value of `architectures` field should be an array of strings." }),
    containerMissingResourceAndBases: (key: string) => ({ key, message: "One of `resource` or `bases` fields should be assigned." }),
    containerOnlyResourceOrBases: (key: string) => ({ key, message: "Only one of `resource` or `bases` fields should be assigned." }),
    containerMountsFieldInvalid: (key: string) => ({ key, message: "Value of `mounts` field should be an array of objects." }),
    containerMountLocationFieldInvalid: (index: number) => ({ index, message: "Value of `location` field should be a string." }),
    containerMountStorageFieldMissing: (index: number) => ({ index, message: "Missing `storage` field." }),
    containerMountStorageFieldInvalid: (index: number) => ({ index, message: "Value of `storage` field should be a string." }),
    assumesFieldInvalid: { key: 'assumes', message: "Value of `assumes` field should be an array." },
    assumesEntryInvalid: (index: number) => ({ index, message: "Value should be a string or an object with one of `all-of` or `any-of` fields." }),
    assumesEntryExtraFields: (index: number) => ({ index, message: "Value should contain only one of `all-of` or `any-of` fields." }),
    assumesAllOfMultipleUsage: (index: number) => ({ index, message: "An `all-of` criterion is already defined." }),
    assumesAllOfInvalid: (index: number) => ({ index, message: "`all-of` value should be an array of strings." }),
    assumesAnyOfMultipleUsage: (index: number) => ({ index, message: "An `any-of` criterion is already defined." }),
    assumesAnyOfInvalid: (index: number) => ({ index, message: "`any-of` value should be an array of strings." }),
    integrityContainerResourceUndefined: (container: string, resource: string) => ({ key: container, message: `Container resource \`${resource}\` is not defined,` }),
    integrityContainerMountStorageUndefined: (mount: number, storage: string) => ({ index: mount, message: `Container mount storage \`${storage}\` is not defined,` }),

} satisfies Record<string, CharmMetadataProblem | ((...args: any[]) => CharmMetadataProblem)>;

export function parseCharmMetadataYAML(content: string): CharmMetadata {
    const doc = tryParseYAML(content);
    const result = emptyMetadata();
    if (!doc || typeof doc !== 'object') {
        result.problems.push(_METADATA_PROBLEMS.invalidYAMLFile);
        return result;
    }

    _required(doc, result, 'string', 'name', 'name', _METADATA_PROBLEMS.nameFieldMissing, _METADATA_PROBLEMS.nameFieldInvalid, result.problems);
    _required(doc, result, 'string', 'display-name', 'displayName', _METADATA_PROBLEMS.displayNameFieldMissing, _METADATA_PROBLEMS.displayNameFieldInvalid, result.problems);
    _required(doc, result, 'string', 'description', 'description', _METADATA_PROBLEMS.descriptionFieldMissing, _METADATA_PROBLEMS.descriptionFieldInvalid, result.problems);
    _required(doc, result, 'string', 'summary', 'summary', _METADATA_PROBLEMS.summaryFieldMissing, _METADATA_PROBLEMS.summaryFieldInvalid, result.problems);

    _optionalValueOrArray(doc, result, 'string', 'source', 'source', _METADATA_PROBLEMS.sourceFieldInvalid, result.problems);
    _optionalValueOrArray(doc, result, 'string', 'issues', 'issues', _METADATA_PROBLEMS.issuesFieldInvalid, result.problems);
    _optionalValueOrArray(doc, result, 'string', 'website', 'website', _METADATA_PROBLEMS.websiteFieldInvalid, result.problems);

    _optionalArray(doc, result, 'string', 'maintainers', 'maintainers', _METADATA_PROBLEMS.maintainersFieldInvalid, result.problems);
    _optionalArray(doc, result, 'string', 'terms', 'terms', _METADATA_PROBLEMS.termsFieldInvalid, result.problems);

    _optional(doc, result, 'string', 'docs', 'docs', _METADATA_PROBLEMS.docsFieldInvalid, result.problems);
    _optional(doc, result, 'boolean', 'subordinate', 'subordinate', _METADATA_PROBLEMS.subordinateFieldInvalid, result.problems);

    _optionalAssumes(doc, result, 'assumes', 'assumes', _METADATA_PROBLEMS.assumesFieldInvalid, result.problems);

    _optionalEndpoints(doc, result, 'requires', 'requires', _METADATA_PROBLEMS.requiresFieldInvalid, result.problems);
    _optionalEndpoints(doc, result, 'provides', 'provides', _METADATA_PROBLEMS.providesFieldInvalid, result.problems);
    _optionalEndpoints(doc, result, 'peers', 'peers', _METADATA_PROBLEMS.peerFieldInvalid, result.problems);

    _optionalResources(doc, result, 'resources', 'resources', _METADATA_PROBLEMS.resourcesFieldInvalid, result.problems);
    _optionalDevices(doc, result, 'devices', 'devices', _METADATA_PROBLEMS.devicesFieldInvalid, result.problems);
    _optionalStorage(doc, result, 'storage', 'storage', _METADATA_PROBLEMS.storageFieldInvalid, result.problems);
    _optionalExtraBindings(doc, result, 'extra-bindings', 'extraBindings', _METADATA_PROBLEMS.extraBindingsFieldInvalid, result.problems);
    _optionalContainers(doc, result, 'containers', 'containers', _METADATA_PROBLEMS.containersFieldInvalid, result.problems);

    result.customFields = Object.fromEntries(Object.entries(doc).filter(([x]) => ![
        'name',
        'display-name',
        'description',
        'summary',
        'source',
        'issues',
        'website',
        'maintainers',
        'terms',
        'docs',
        'subordinate',
        'assumes',
        'requires',
        'provides',
        'peers',
        'resources',
        'devices',
        'storage',
        'extra-bindings',
        'containers',
    ].includes(x)));

    if (result.containers) {
        for (const container of result.containers) {
            // Checking container resources, if any, are already defined.
            if (container.resource !== undefined && !result.resources?.find(x => x.name === container.resource)) {
                container.problems.push(_METADATA_PROBLEMS.integrityContainerResourceUndefined(container.name, container.resource));
            }

            // Checking container mount storages, if any, are already defined.
            if (container.mounts) {
                for (let i = 0; i < container.mounts.length; i++) {
                    const mount = container.mounts[i];
                    if (!result.storage?.find(x => x.name === mount.storage)) {
                        container.problems.push(_METADATA_PROBLEMS.integrityContainerMountStorageUndefined(i, mount.storage));
                    }
                }
            }
        }
    }

    return result;

    function _required<T>(doc: any, result: T, t: 'string' | 'boolean' | 'number' | 'int', key: string, mapToKey: keyof T, missing: CharmMetadataProblem, invalid: CharmMetadataProblem, problems: CharmMetadataProblem[]) {
        if (!(key in doc)) {
            problems.push(missing);
        } else if (doc[key] !== undefined && doc[key] !== null && doc[key] && t === 'int' && typeof doc[key] === 'number' && Number.isInteger(doc[key])) {
            (result as any)[mapToKey] = doc[key];
        } else if (doc[key] === undefined || doc[key] === null || typeof doc[key] !== t) {
            problems.push(invalid);
        } else {
            (result as any)[mapToKey] = doc[key];
        }
    }

    function _optional<T>(doc: any, result: T, t: 'boolean' | 'number' | 'string' | 'int', key: string, mapToKey: keyof T, invalid: CharmMetadataProblem, problems: CharmMetadataProblem[]) {
        if (!(key in doc)) {
            return;
        }
        if (doc[key] !== undefined && doc[key] !== null && t === 'int' && typeof doc[key] === 'number' && Number.isInteger(doc[key])) {
            (result as any)[mapToKey] = doc[key];
        } else if (doc[key] !== undefined && doc[key] !== null && typeof doc[key] === t) {
            (result as any)[mapToKey] = doc[key];
        } else {
            problems.push(invalid);
        }
    }

    function _optionalValueOrArray<T>(doc: any, result: T, t: 'string' | 'boolean' | 'number', key: string, mapToKey: keyof T, invalid: CharmMetadataProblem, problems: CharmMetadataProblem[]) {
        if (!(key in doc)) {
            return;
        }
        if (doc[key] !== undefined && doc[key] !== null && doc[key] && typeof doc[key] === t) {
            (result as any)[mapToKey] = doc[key];
        } else if (doc[key] !== undefined && doc[key] !== null && typeof doc[key] === 'object' && Array.isArray(doc[key]) && (doc[key] as Array<any>).every(x => typeof x === t)) {
            (result as any)[mapToKey] = doc[key];
        } else {
            problems.push(invalid);
        }
    }

    function _requiredArray<T>(doc: any, result: T, t: 'string' | 'boolean' | 'number', key: string, mapToKey: keyof T, missing: CharmActionProblem, invalid: CharmMetadataProblem, problems: CharmMetadataProblem[]) {
        if (!(key in doc)) {
            problems.push(missing);
        } else {
            _optionalArray(doc, result, t, key, mapToKey, invalid, problems);
        }
    }

    function _optionalArray<T>(doc: any, result: T, t: 'string' | 'boolean' | 'number', key: string, mapToKey: keyof T, invalid: CharmMetadataProblem, problems: CharmMetadataProblem[]) {
        if (!(key in doc)) {
            return;
        }
        if (doc[key] !== undefined && doc[key] !== null && typeof doc[key] === 'object' && Array.isArray(doc[key]) && (doc[key] as Array<any>).every(x => typeof x === t)) {
            (result as any)[mapToKey] = doc[key];
        } else {
            problems.push(invalid);
        }
    }

    function _optionalStringEnum<T>(doc: any, result: T, enumValues: string[], key: string, mapToKey: keyof T, invalid: CharmMetadataProblem, problems: CharmMetadataProblem[]) {
        if (!(key in doc)) {
            return;
        }
        if (typeof doc[key] === 'string' && enumValues.includes(doc[key])) {
            (result as any)[mapToKey] = doc[key];
        } else {
            problems.push(invalid);
        }
    }

    function _requiredStringEnum<T>(doc: any, result: T, enumValues: string[], key: string, mapToKey: keyof T, missing: CharmMetadataProblem, invalid: CharmMetadataProblem, problems: CharmMetadataProblem[]) {
        if (!(key in doc)) {
            problems.push(missing);
        } else {
            _optionalStringEnum(doc, result, enumValues, key, mapToKey, invalid, problems);
        }
    }

    function _optionalEndpoints<T>(doc: any, result: T, key: string, mapToKey: keyof T, invalid: CharmMetadataProblem, problems: CharmMetadataProblem[]) {
        if (!doc[key]) {
            return;
        }
        const map = doc[key];
        if (!map || typeof map !== 'object' || Array.isArray(map)) {
            problems.push(invalid);
            return;
        }

        const endpoints: CharmEndpoint[] = [];
        (result as any)[mapToKey] = endpoints;

        for (const [key, value] of Object.entries(map)) {
            const entry: CharmEndpoint = {
                name: key,
                interface: '',
                problems: [],
            };
            endpoints.push(entry);

            if (!value || typeof value !== 'object' || Array.isArray(value)) {
                entry.problems.push(_METADATA_PROBLEMS.endpointEntryInvalid(key));
                continue;
            }

            _required(value, entry, 'string', 'interface', 'interface', _METADATA_PROBLEMS.endpointInterfaceFieldMissing(key), _METADATA_PROBLEMS.endpointInterfaceFieldInvalid(key), entry.problems);
            _optional(value, entry, 'int', 'limit', 'limit', _METADATA_PROBLEMS.endpointLimitFieldInvalid(key), entry.problems);
            _optional(value, entry, 'boolean', 'optional', 'optional', _METADATA_PROBLEMS.endpointOptionalFieldInvalid(key), entry.problems);
            _optionalStringEnum(value, entry, ['global', 'container'], 'scope', 'scope', _METADATA_PROBLEMS.endpointScopeFieldInvalid(key), entry.problems);
        }
    }

    function _optionalResources<T>(doc: any, result: T, key: string, mapToKey: keyof T, invalid: CharmMetadataProblem, problems: CharmMetadataProblem[]) {
        if (!doc[key]) {
            return;
        }
        const map = doc[key];
        if (!map || typeof map !== 'object' || Array.isArray(map)) {
            problems.push(invalid);
            return;
        }

        const resources: CharmResource[] = [];
        (result as any)[mapToKey] = resources;

        for (const [key, value] of Object.entries(map)) {
            const entry: CharmResource = {
                name: key,
                type: 'unknown',
                problems: [],
            };
            resources.push(entry);

            if (!value || typeof value !== 'object' || Array.isArray(value)) {
                entry.problems.push(_METADATA_PROBLEMS.resourceEntryInvalid(key));
                continue;
            }

            _requiredStringEnum(value, entry, ['file', 'oci-image'], 'type', 'type', _METADATA_PROBLEMS.resourceTypeFieldMissing(key), _METADATA_PROBLEMS.resourceTypeFieldInvalid(key), entry.problems);
            _optional(value, entry, 'string', 'description', 'description', _METADATA_PROBLEMS.resourceDescriptionFieldInvalid(key), entry.problems);
            if (entry.type === 'file') {
                _required(value, entry, 'string', 'filename', 'filename', _METADATA_PROBLEMS.resourceFilenameFieldMissing(key), _METADATA_PROBLEMS.resourceFilenameFieldInvalid(key), entry.problems);
            } else if (entry.type === 'oci-image' && (value as any)['filename'] !== undefined) {
                entry.problems.push(_METADATA_PROBLEMS.resourceFilenameFieldUnrelated(key));
            }
        }
    }

    function _optionalDevices<T>(doc: any, result: T, key: string, mapToKey: keyof T, invalid: CharmMetadataProblem, problems: CharmMetadataProblem[]) {
        if (!doc[key]) {
            return;
        }
        const map = doc[key];
        if (!map || typeof map !== 'object' || Array.isArray(map)) {
            problems.push(invalid);
            return;
        }

        const devices: CharmDevice[] = [];
        (result as any)[mapToKey] = devices;

        for (const [key, value] of Object.entries(map)) {
            const entry: CharmDevice = {
                name: key,
                type: 'unknown',
                problems: [],
            };
            devices.push(entry);

            if (!value || typeof value !== 'object' || Array.isArray(value)) {
                entry.problems.push(_METADATA_PROBLEMS.deviceEntryInvalid(key));
                continue;
            }

            _requiredStringEnum(value, entry, ['gpu', 'nvidia.com/gpu', 'amd.com/gpu'], 'type', 'type', _METADATA_PROBLEMS.deviceTypeFieldMissing(key), _METADATA_PROBLEMS.deviceTypeFieldInvalid(key), entry.problems);
            _optional(value, entry, 'string', 'description', 'description', _METADATA_PROBLEMS.deviceDescriptionFieldInvalid(key), entry.problems);
            _optional(value, entry, 'int', 'countmin', 'countMin', _METADATA_PROBLEMS.deviceCountMinFieldInvalid(key), entry.problems);
            _optional(value, entry, 'int', 'countmax', 'countMax', _METADATA_PROBLEMS.deviceCountMaxFieldInvalid(key), entry.problems);
        }
    }

    function _optionalStorage<T>(doc: any, result: T, key: string, mapToKey: keyof T, invalid: CharmMetadataProblem, problems: CharmMetadataProblem[]) {
        if (!doc[key]) {
            return;
        }
        const map = doc[key];
        if (!map || typeof map !== 'object' || Array.isArray(map)) {
            problems.push(invalid);
            return;
        }

        const storages: CharmStorage[] = [];
        (result as any)[mapToKey] = storages;

        for (const [key, value] of Object.entries(map)) {
            const entry: CharmStorage = {
                name: key,
                type: 'unknown',
                problems: [],
            };
            storages.push(entry);

            if (!value || typeof value !== 'object' || Array.isArray(value)) {
                entry.problems.push(_METADATA_PROBLEMS.storageEntryInvalid(key));
                continue;
            }

            _requiredStringEnum(value, entry, ['filesystem', 'block'], 'type', 'type', _METADATA_PROBLEMS.storageTypeFieldMissing(key), _METADATA_PROBLEMS.storageTypeFieldInvalid(key), entry.problems);
            _optional(value, entry, 'string', 'description', 'description', _METADATA_PROBLEMS.storageDescriptionFieldInvalid(key), entry.problems);
            _optional(value, entry, 'string', 'location', 'location', _METADATA_PROBLEMS.storageLocationFieldInvalid(key), entry.problems);
            _optional(value, entry, 'boolean', 'shared', 'shared', _METADATA_PROBLEMS.storageSharedFieldInvalid(key), entry.problems);
            _optional(value, entry, 'boolean', 'read-only', 'readOnly', _METADATA_PROBLEMS.storageReadOnlyFieldInvalid(key), entry.problems);

            const v = value as any;

            if (v['properties']) {
                const props = v['properties'];
                if (!props || typeof props !== 'object' || !Array.isArray(props) || !props.every(x => typeof x === 'string' && ['transient'].includes(x))) {
                    entry.problems.push(_METADATA_PROBLEMS.storagePropertiesFieldInvalid(key));
                } else {
                    entry.properties = props;
                }
            }

            if (v['multiple']) {
                const multiple = v['multiple'];
                if (multiple !== undefined && multiple !== null) {
                    if (typeof multiple === 'number' && Number.isInteger(multiple)) {
                        entry.multiple = multiple.toString();
                    } else if (typeof multiple === 'string' && multiple.match(/\d+(\+|-)?|\d+-\d+/)) {
                        entry.multiple = multiple;
                    } else {
                        entry.problems.push(_METADATA_PROBLEMS.storageMultipleFieldInvalid(key));
                    }
                } else {
                    entry.problems.push(_METADATA_PROBLEMS.storageMultipleFieldInvalid(key));
                }
            }

            if (v['minimum-size']) {
                const minimumSize = v['minimum-size'];
                if (minimumSize !== undefined && minimumSize !== null) {
                    if (typeof minimumSize === 'number' && Number.isInteger(minimumSize)) {
                        entry.minimumSize = minimumSize.toString();
                    } else if (typeof minimumSize === 'string' && minimumSize.match(/\d+[MGTPEZY]?/)) {
                        entry.minimumSize = minimumSize;
                    } else {
                        entry.problems.push(_METADATA_PROBLEMS.storageMinimumSizeFieldInvalid(key));
                    }
                } else {
                    entry.problems.push(_METADATA_PROBLEMS.storageMinimumSizeFieldInvalid(key));
                }
            }
        }
    }

    function _optionalExtraBindings<T>(doc: any, result: T, key: string, mapToKey: keyof T, invalid: CharmMetadataProblem, problems: CharmMetadataProblem[]) {
        if (!doc[key]) {
            return;
        }
        const map = doc[key];
        if (!map || typeof map !== 'object' || Array.isArray(map)) {
            problems.push(invalid);
            return;
        }

        const extraBindings: CharmExtraBinding[] = [];
        (result as any)[mapToKey] = extraBindings;

        for (const [key, value] of Object.entries(map)) {
            const entry: CharmExtraBinding = {
                name: key,
                problems: [],
            };
            extraBindings.push(entry);

            if (value !== null) {
                entry.problems.push(_METADATA_PROBLEMS.extraBindingEntryInvalid(key));
                continue;
            }
        }
    }

    function _optionalContainers<T>(doc: any, result: T, key: string, mapToKey: keyof T, invalid: CharmMetadataProblem, problems: CharmMetadataProblem[]) {
        if (!doc[key]) {
            return;
        }
        const map = doc[key];
        if (!map || typeof map !== 'object' || Array.isArray(map)) {
            problems.push(invalid);
            return;
        }

        const containers: CharmContainer[] = [];
        (result as any)[mapToKey] = containers;

        for (const [key, value] of Object.entries(map)) {
            const entry: CharmContainer = {
                name: key,
                problems: [],
            };
            containers.push(entry);

            if (!value || typeof value !== 'object' || Array.isArray(value)) {
                entry.problems.push(_METADATA_PROBLEMS.containerEntryInvalid(key));
                continue;
            }

            _optional(value, entry, 'string', 'resource', 'resource', _METADATA_PROBLEMS.containerResourceFieldInvalid(key), entry.problems);

            const v = value as any;

            if ('bases' in v) {
                const bases = v['bases'];
                if (bases !== undefined && bases !== null && typeof bases === 'object' && Array.isArray(bases)) {
                    entry.bases = [];
                    for (let i = 0; i < bases.length; i++) {
                        const b = bases[i];
                        const e: CharmContainerBase = {
                            name: '',
                            channel: '',
                            architectures: [],
                            problems: [],
                        };
                        entry.bases.push(e);

                        _required(b, e, 'string', 'name', 'name', _METADATA_PROBLEMS.containerBaseNameFieldMissing(i), _METADATA_PROBLEMS.containerBaseNameFieldInvalid(i), e.problems);
                        _required(b, e, 'string', 'channel', 'channel', _METADATA_PROBLEMS.containerBaseChannelFieldMissing(i), _METADATA_PROBLEMS.containerBaseChannelFieldInvalid(i), e.problems);
                        _requiredArray(b, e, 'string', 'architectures', 'architectures', _METADATA_PROBLEMS.containerBaseArchitecturesFieldMissing(i), _METADATA_PROBLEMS.containerBaseArchitecturesFieldInvalid(i), e.problems);
                    }
                } else {
                    entry.problems.push(_METADATA_PROBLEMS.containerBasesFieldInvalid(key));
                }
            }

            if (entry.resource === undefined && entry.bases === undefined) {
                entry.problems.push(_METADATA_PROBLEMS.containerMissingResourceAndBases(key));
            } else if (entry.resource !== undefined && entry.bases !== undefined) {
                entry.problems.push(_METADATA_PROBLEMS.containerOnlyResourceOrBases(key));
            }

            if ('mounts' in v) {
                const mounts = v['mounts'];
                if (mounts !== undefined && mounts !== null && typeof mounts === 'object' && Array.isArray(mounts)) {
                    entry.mounts = [];
                    for (let i = 0; i < mounts.length; i++) {
                        const m = mounts[i];
                        const e: CharmContainerMount = {
                            storage: '',
                            problems: [],
                        };
                        entry.mounts.push(e);

                        _required(m, e, 'string', 'storage', 'storage', _METADATA_PROBLEMS.containerMountStorageFieldMissing(i), _METADATA_PROBLEMS.containerMountStorageFieldInvalid(i), e.problems);
                        _optional(m, e, 'string', 'location', 'location', _METADATA_PROBLEMS.containerMountLocationFieldInvalid(i), e.problems);
                    }
                } else {
                    entry.problems.push(_METADATA_PROBLEMS.containerMountsFieldInvalid(key));
                }
            }
        }
    }

    function _optionalAssumes<T>(doc: any, result: T, key: string, mapToKey: keyof T, invalid: CharmMetadataProblem, problems: CharmMetadataProblem[]) {
        if (!doc[key]) {
            return;
        }
        const ls = doc[key];
        if (!ls || typeof ls !== 'object' || !Array.isArray(ls)) {
            problems.push(invalid);
            return;
        }

        const assumptions: CharmAssumptions = { problems: [] };
        (result as any)[mapToKey] = assumptions;

        for (let i = 0; i < ls.length; i++) {
            const element = ls[i];

            if (element !== undefined && element !== null && typeof element === 'string') {
                if (!assumptions.singles) {
                    assumptions.singles = [];
                }
                assumptions.singles.push(element);
            } else if (element && typeof element === 'object' && !Array.isArray(element)) {
                if ('all-of' in element) {
                    if (assumptions.allOf) {
                        assumptions.problems.push(_METADATA_PROBLEMS.assumesAllOfMultipleUsage(i));
                    } else {
                        const allOf = element['all-of'];
                        if (Object.keys(element).length !== 1) {
                            assumptions.problems.push(_METADATA_PROBLEMS.assumesEntryExtraFields(i));
                        } else if (allOf && typeof allOf === 'object' && Array.isArray(allOf) && allOf.every(x => typeof x === 'string')) {
                            assumptions.allOf = allOf;
                        } else {
                            assumptions.problems.push(_METADATA_PROBLEMS.assumesAllOfInvalid(i));
                        }
                    }
                } else if ('any-of' in element) {
                    if (assumptions.anyOf) {
                        assumptions.problems.push(_METADATA_PROBLEMS.assumesAnyOfMultipleUsage(i));
                    } else {
                        const anyOf = element['any-of'];
                        if (Object.keys(element).length !== 1) {
                            assumptions.problems.push(_METADATA_PROBLEMS.assumesEntryExtraFields(i));
                        } else if (anyOf && typeof anyOf === 'object' && Array.isArray(anyOf) && anyOf.every(x => typeof x === 'string')) {
                            assumptions.anyOf = anyOf;
                        } else {
                            assumptions.problems.push(_METADATA_PROBLEMS.assumesAnyOfInvalid(i));
                        }
                    }
                }
            } else {
                assumptions.problems.push(_METADATA_PROBLEMS.assumesEntryInvalid(i));
            }
        }
    }
}

export async function getPythonAST(content: string): Promise<any | undefined> {
    const tmp = await mkdtemp(path.join(tmpdir(), 'juju-charms-ide'));
    try {
        const tmpfile = path.join(tmp, 'temp.py');
        const scriptPath = path.join(__dirname, '../resource/ast/python-ast-to-json.py');
        await writeFile(tmpfile, content);

        const [exitCode, ast] = await new Promise<[number, string]>(function (resolve, reject) {
            let data = '';
            const process = spawn('python3', [scriptPath, tmpfile]);
            process.on('close', function (code) {
                resolve([code || 0, data]);
            });
            process.stdout.on('data', chunk => {
                data += chunk.toString();
            });
        });
        return exitCode === 0 ? JSON.parse(ast) : undefined;
    } catch {
        return undefined;
    } finally {
        await rm(tmp, { recursive: true, force: true });
    }
}