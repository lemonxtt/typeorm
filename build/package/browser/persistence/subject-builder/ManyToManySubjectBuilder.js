import { Subject } from "../Subject";
import { OrmUtils } from "../../util/OrmUtils";
import { EntityMetadata } from "../../metadata/EntityMetadata";
/**
 * Builds operations needs to be executed for many-to-many relations of the given subjects.
 *
 * by example: post contains owner many-to-many relation with categories in the property called "categories", e.g.
 *             @ManyToMany(type => Category, category => category.posts) categories: Category[]
 *             If user adds categories into the post and saves post we need to bind them.
 *             This operation requires updation of junction table.
 */
var ManyToManySubjectBuilder = /** @class */ (function () {
    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------
    function ManyToManySubjectBuilder(subjects) {
        this.subjects = subjects;
    }
    // ---------------------------------------------------------------------
    // Public Methods
    // ---------------------------------------------------------------------
    /**
     * Builds operations for any changes in the many-to-many relations of the subjects.
     */
    ManyToManySubjectBuilder.prototype.build = function () {
        var _this = this;
        this.subjects.forEach(function (subject) {
            // if subject doesn't have entity then no need to find something that should be inserted or removed
            if (!subject.entity)
                return;
            // go through all persistence enabled many-to-many relations and build subject operations for them
            subject.metadata.manyToManyRelations.forEach(function (relation) {
                // skip relations for which persistence is disabled
                if (relation.persistenceEnabled === false)
                    return;
                _this.buildForSubjectRelation(subject, relation);
            });
        });
    };
    /**
     * Builds operations for removal of all many-to-many records of all many-to-many relations of the given subject.
     */
    ManyToManySubjectBuilder.prototype.buildForAllRemoval = function (subject) {
        var _this = this;
        // if subject does not have a database entity then it means it does not exist in the database
        // if it does not exist in the database then we don't have anything for deletion
        if (!subject.databaseEntity)
            return;
        // go through all persistence enabled many-to-many relations and build subject operations for them
        subject.metadata.manyToManyRelations.forEach(function (relation) {
            // skip relations for which persistence is disabled
            if (relation.persistenceEnabled === false)
                return;
            // get all related entities (actually related entity relation ids) bind to this subject entity
            // by example: returns category ids of the post we are currently working with (subject.entity is post)
            var relatedEntityRelationIdsInDatabase = relation.getEntityValue(subject.databaseEntity);
            // go through all related entities and create a new junction subject for each row in junction table
            relatedEntityRelationIdsInDatabase.forEach(function (relationId) {
                var junctionSubject = new Subject({
                    metadata: relation.junctionEntityMetadata,
                    parentSubject: subject,
                    mustBeRemoved: true,
                    identifier: _this.buildJunctionIdentifier(subject, relation, relationId)
                });
                // we use unshift because we need to perform those operations before post deletion is performed
                // but post deletion was already added as an subject
                // this is temporary solution, later we need to implement proper sorting of subjects before their removal
                _this.subjects.push(junctionSubject);
            });
        });
    };
    // ---------------------------------------------------------------------
    // Protected Methods
    // ---------------------------------------------------------------------
    /**
     * Builds operations for a given subject and relation.
     *
     * by example: subject is "post" entity we are saving here and relation is "categories" inside it here.
     */
    ManyToManySubjectBuilder.prototype.buildForSubjectRelation = function (subject, relation) {
        var _this = this;
        // load from db all relation ids of inverse entities that are "bind" to the subject's entity
        // this way we gonna check which relation ids are missing and which are new (e.g. inserted or removed)
        var databaseRelatedEntityIds = [];
        // if subject don't have database entity it means all related entities in persisted subject are new and must be bind
        // and we don't need to remove something that is not exist
        if (subject.databaseEntity)
            databaseRelatedEntityIds = relation.getEntityValue(subject.databaseEntity);
        // extract entity's relation value
        // by example: categories inside our post (subject.entity is post)
        var relatedEntities = relation.getEntityValue(subject.entity);
        if (relatedEntities === null) // if value set to null its equal if we set it to empty array - all items must be removed from the database
            relatedEntities = [];
        if (!(relatedEntities instanceof Array))
            return;
        // from all related entities find only those which aren't found in the db - for them we will create operation subjects
        relatedEntities.forEach(function (relatedEntity) {
            // todo: check how it will work for entities which are saved by cascades, but aren't saved in the database yet
            // extract only relation id from the related entities, since we only need it for comparision
            // by example: extract from category only relation id (category id, or let's say category title, depend on join column options)
            var relatedEntityRelationIdMap = relation.inverseEntityMetadata.getEntityIdMap(relatedEntity);
            // try to find a subject of this related entity, maybe it was loaded or was marked for persistence
            var relatedEntitySubject = _this.subjects.find(function (subject) {
                return subject.entity === relatedEntity;
            });
            // if subject with entity was found take subject identifier as relation id map since it may contain extra properties resolved
            if (relatedEntitySubject)
                relatedEntityRelationIdMap = relatedEntitySubject.identifier;
            // if related entity relation id map is empty it means related entity is newly persisted
            if (!relatedEntityRelationIdMap) {
                // we decided to remove this error because it brings complications when saving object with non-saved entities
                // if related entity does not have a subject then it means user tries to bind entity which wasn't saved
                // in this persistence because he didn't pass this entity for save or he did not set cascades
                // but without entity being inserted we cannot bind it in the relation operation, so we throw an exception here
                // we decided to remove this error because it brings complications when saving object with non-saved entities
                // if (!relatedEntitySubject)
                //     throw new Error(`Many-to-many relation "${relation.entityMetadata.name}.${relation.propertyPath}" contains ` +
                //         `entities which do not exist in the database yet, thus they cannot be bind in the database. ` +
                //         `Please setup cascade insertion or save entities before binding it.`);
                if (!relatedEntitySubject)
                    return;
            }
            // try to find related entity in the database
            // by example: find post's category in the database post's categories
            var relatedEntityExistInDatabase = databaseRelatedEntityIds.find(function (databaseRelatedEntityRelationId) {
                return EntityMetadata.compareIds(databaseRelatedEntityRelationId, relatedEntityRelationIdMap);
            });
            // if entity is found then don't do anything - it means binding in junction table already exist, we don't need to add anything
            if (relatedEntityExistInDatabase)
                return;
            var ownerValue = relation.isOwning ? subject : (relatedEntitySubject || relatedEntity); // by example: ownerEntityMap is post from subject here
            var inverseValue = relation.isOwning ? (relatedEntitySubject || relatedEntity) : subject; // by example: inverseEntityMap is category from categories array here
            // create a new subject for insert operation of junction rows
            var junctionSubject = new Subject({
                metadata: relation.junctionEntityMetadata,
                parentSubject: subject,
                canBeInserted: true,
            });
            _this.subjects.push(junctionSubject);
            relation.junctionEntityMetadata.ownerColumns.forEach(function (column) {
                junctionSubject.changeMaps.push({
                    column: column,
                    value: ownerValue,
                });
            });
            relation.junctionEntityMetadata.inverseColumns.forEach(function (column) {
                junctionSubject.changeMaps.push({
                    column: column,
                    value: inverseValue,
                });
            });
        });
        // get all inverse entities relation ids that are "bind" to the currently persisted entity
        var changedInverseEntityRelationIds = [];
        relatedEntities.forEach(function (relatedEntity) {
            // relation.inverseEntityMetadata!.getEntityIdMap(relatedEntity)
            var relatedEntityRelationIdMap = relation.inverseEntityMetadata.getEntityIdMap(relatedEntity);
            // try to find a subject of this related entity, maybe it was loaded or was marked for persistence
            var relatedEntitySubject = _this.subjects.find(function (subject) {
                return subject.entity === relatedEntity;
            });
            // if subject with entity was found take subject identifier as relation id map since it may contain extra properties resolved
            if (relatedEntitySubject)
                relatedEntityRelationIdMap = relatedEntitySubject.identifier;
            if (relatedEntityRelationIdMap !== undefined && relatedEntityRelationIdMap !== null)
                changedInverseEntityRelationIds.push(relatedEntityRelationIdMap);
        });
        // now from all entities in the persisted entity find only those which aren't found in the db
        var removedJunctionEntityIds = databaseRelatedEntityIds.filter(function (existRelationId) {
            return !changedInverseEntityRelationIds.find(function (changedRelationId) {
                return EntityMetadata.compareIds(changedRelationId, existRelationId);
            });
        });
        // finally create a new junction remove operations for missing related entities
        removedJunctionEntityIds.forEach(function (removedEntityRelationId) {
            var junctionSubject = new Subject({
                metadata: relation.junctionEntityMetadata,
                parentSubject: subject,
                mustBeRemoved: true,
                identifier: _this.buildJunctionIdentifier(subject, relation, removedEntityRelationId)
            });
            _this.subjects.push(junctionSubject);
        });
    };
    /**
     * Creates identifiers for junction table.
     * Example: { postId: 1, categoryId: 2 }
     */
    ManyToManySubjectBuilder.prototype.buildJunctionIdentifier = function (subject, relation, relationId) {
        var ownerEntityMap = relation.isOwning ? subject.entity : relationId;
        var inverseEntityMap = relation.isOwning ? relationId : subject.entity;
        var identifier = {};
        relation.junctionEntityMetadata.ownerColumns.forEach(function (column) {
            OrmUtils.mergeDeep(identifier, column.createValueMap(column.referencedColumn.getEntityValue(ownerEntityMap)));
        });
        relation.junctionEntityMetadata.inverseColumns.forEach(function (column) {
            OrmUtils.mergeDeep(identifier, column.createValueMap(column.referencedColumn.getEntityValue(inverseEntityMap)));
        });
        return identifier;
    };
    return ManyToManySubjectBuilder;
}());
export { ManyToManySubjectBuilder };

//# sourceMappingURL=ManyToManySubjectBuilder.js.map
