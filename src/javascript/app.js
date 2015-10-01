Ext.define("TSTimeTrackingByActualsChange", {
    extend: 'Rally.app.App',
    componentCls: 'app',
    logger: new Rally.technicalservices.Logger(),
    defaults: { margin: 10 },
    items: [
        {xtype:'container',itemId:'selector_box'},
        {xtype:'container',itemId:'display_box'}
    ],
    
    start_date: null,
    end_date  : null,
    
    config: {
        defaultSettings: {
            typeField: 'State'
        }
    },
    
    launch: function() {
        var me = this;
        this._addSelectors(this.down('#selector_box'));
    },
    
    _addSelectors: function(container) {
        container.removeAll();
        
        container.add({
            xtype:'rallydatefield',
            itemId:'start_date_selector',
            fieldLabel: 'Start:',
            labelWidth: 45,
            stateful: true,
            stateId: 'rally_techservices_timebychange_start',
            stateEvents: ['change'],
            listeners: { 
                scope: this,
                change: function(db) {
                    this.start_date = db.getValue();
                    this._updateData();
                }
            }
        });
        
        container.add({
            xtype:'rallydatefield',
            itemId:'end_date_selector',
            fieldLabel: 'End:',
            labelWidth: 45,
            stateful: true,
            stateId: 'rally_techservices_timebychange_end',
            stateEvents: ['change'],
            listeners: { 
                scope: this,
                change: function(db) {
                    this.end_date = db.getValue();
                    this._updateData();
                }
            }
        });
        
    },
    
    _updateData: function() {
        var me = this;
        this.logger.log('updateData');

        if ( this._hasNeededDates() ) {
            var start_date = Rally.util.DateTime.toIsoString(this.start_date);
            var end_date =   Rally.util.DateTime.toIsoString(this.end_date);
            
            if ( end_date < start_date ) {
                var holder = end_date;
                end_date = start_date;
                start_date = holder;
            }
            
            this.logger.log("From:", start_date, " to:", end_date);
            this.setLoading("Loading actuals...");

            this._getTasksThatChanged(start_date, end_date).then({
                scope: this,
                success: function(snaps) {
                    var rows = this._getTasksFromSnaps(snaps);
                    this.setLoading("Gathering Related Information");
                    
                    this._getStoriesByOID(rows).then({
                        scope: this,
                        success: function(stories_by_oid) {
                            this._updateEpicInformation(rows,stories_by_oid);
                            
                            this._updateOwnerInformation(rows);
                            
                            this._addGrid(rows); 
                        },
                        failure: function(msg) {
                            Ext.Msg.alert("Problem loading ancillary data", msg);
                        }
                    
                    }).always(function() { me.setLoading(false); });

                }
            }).always(function() { me.setLoading(false); });
        }
    },
    
    _hasNeededDates: function() {
        return ( this.start_date && this.end_date );
    },
    
    _getTasksThatChanged: function(start_date,end_date) {
        var config = {
            filters: [
                {property:'_ProjectHierarchy', operator:'in', value: [this.getContext().getProject().ObjectID]},
                {property:'_TypeHierarchy', value:'Task'},
                {property: '_ValidFrom',operator: '>=', value: start_date},
                {property: '_ValidFrom',operator: '<=', value: end_date},
                {property: '_PreviousValues.Actuals', operator: 'exists', value: true},
                {property:'Actuals',operator:'>',value: 0}
            ],
            fetch: ['_PreviousValues.Actuals','FormattedID','Owner','Actuals','Name','WorkProduct', this.getSetting('typeField')],
            sorters: [{property:'_ValidFrom',direction:'ASC'}]
        };
        return this._loadSnapshots(config);
        
    },
    
    _getTasksFromSnaps: function(snaps) {
        this.logger.log("_getTasksFromSnaps",snaps);
        var row_hash = {};
        Ext.Array.each(snaps, function(snap){
            var oid = snap.get('ObjectID');
            var old_value = snap.get('_PreviousValues.Actuals');
            var new_value = snap.get('Actuals');
            var delta = new_value - old_value;
            if ( !row_hash[oid] ) { 
                row_hash[oid] = {
                    __delta: 0
                };
            }
            row_hash[oid].__delta = row_hash[oid].__delta + delta;
            
            // apply the most current values of these records to the row
            Ext.apply(row_hash[oid], snap.getData());
            
            this.logger.log(snap.get('FormattedID'), delta);
        },this);
        
        return Ext.Object.getValues(row_hash);
    },
    
    _getStoriesByOID: function(rows) {
        var deferred = Ext.create('Deft.Deferred');
        var workproducts = Ext.Array.pluck(rows,'WorkProduct');
        var unique_workproducts = Ext.Array.unique(workproducts);
        
        console.log('work products:', unique_workproducts);
        
        var filter_array = Ext.Array.map(unique_workproducts, function(wp) {
            return { property: 'ObjectID', value: wp };
        });
        
        var config = {
            filters: Rally.data.wsapi.Filter.or(filter_array),
            model  : 'HierarchicalRequirement',
            limit  : Infinity,
            fetch  : ['FormattedID','Name','Feature','Parent']
        };
        
        this._loadWSAPIItems(config).then({
            success: function(stories) {
                var stories_by_oid = {};
                Ext.Array.each(stories, function(story){
                    stories_by_oid[story.get('ObjectID')] = story;
                });
                deferred.resolve(stories_by_oid);
            },
            failure: function(msg) {
                deferred.reject(msg);
            }
        });
        return deferred.promise;
    },
    
    _updateEpicInformation: function(rows,stories_by_oid) {
        Ext.Array.each(rows, function(row){
            var wp_oid = row.WorkProduct;
            var story = stories_by_oid[wp_oid];
            
            console.log(story);
            
            if (story && story.get('Feature')) {
                row['__epic'] = story.get('Feature').Parent;
            } else {
                row['__epic'] = {};
            }
        });
    },
    
    _updateOwnerInformation: function(rows) {
        var owners = Ext.Array.pluck(rows, 'Owner');
        var unique_owners = Ext.Array.unique(owners);
        
        console.log('owners:',unique_owners);
    },
    
    _loadSnapshots: function(config) {
        var deferred = Ext.create('Deft.Deferred');
        var me = this;
        this.logger.log("Starting snapshot load");
        
        var default_config = {
            fetch: ['ObjectID']
        };
        
        Ext.create('Rally.data.lookback.SnapshotStore', Ext.merge(default_config,config)).load({
            callback : function(records, operation, successful) {
                if (successful){
                    deferred.resolve(records);
                } else {
                    me.logger.log("Failed: ", operation);
                    deferred.reject('Problem loading: ' + operation.error.errors.join('. '));
                }
            }
        });
        return deferred.promise;
    },
    
    _loadWSAPIItems: function(config){
        var deferred = Ext.create('Deft.Deferred');
        var me = this;
        
        var default_config = {
            fetch: ['ObjectID']
        };
        
        Ext.create('Rally.data.wsapi.Store', Ext.merge(default_config,config)).load({
            callback : function(records, operation, successful) {
                if (successful){
                    deferred.resolve(records);
                } else {
                    me.logger.log("Failed: ", operation);
                    deferred.reject('Problem loading: ' + operation.error.errors.join('. '));
                }
            }
        });
        return deferred.promise;
    },
    
    _addGrid: function(rows){
        this.logger.log('_addGrid', rows);
        
        this.down('#display_box').removeAll();
        var store = Ext.create('Rally.data.custom.Store',{data:rows});
        
        this.down('#display_box').add({
            xtype:'rallygrid',
            store: store,
            showPagingToolbar: false,
            columnCfgs: [
                {dataIndex:'FormattedID', text:'Task Number'},
                {dataIndex: this.getSetting('typeField'), text: 'Task Type' },
                {dataIndex: 'Owner', text: 'Task Owner' },
                {dataIndex:'__delta', text:'Actual Time'},
                {dataIndex:'__epic', text: 'Epic', renderer: function(v) {
                    if ( !v.FormattedID ) {
                        return "--";
                    } 
                    
                    return v.FormattedID;
                } }
            ]
        });
    },
    
    
    getOptions: function() {
        return [
            {
                text: 'About...',
                handler: this._launchInfo,
                scope: this
            }
        ];
    },
    
    _launchInfo: function() {
        if ( this.about_dialog ) { this.about_dialog.destroy(); }
        this.about_dialog = Ext.create('Rally.technicalservices.InfoLink',{});
    },
    
    isExternal: function(){
        return typeof(this.getAppId()) == 'undefined';
    },
    
    //onSettingsUpdate:  Override
    onSettingsUpdate: function (settings){
        this.logger.log('onSettingsUpdate',settings);
        // Ext.apply(this, settings);
        this.launch();
    },
    
    _filterOutExceptChoices: function(store) {
        var app = Rally.getApp();
        app.logger.log('_filterOutExceptChoices');
        
        store.filter([{
            filterFn:function(field){ 
                app.logger.log('field:', field);
                
                var attribute_definition = field.get('fieldDefinition').attributeDefinition;
                var attribute_type = null;
                if ( attribute_definition ) {
                    attribute_type = attribute_definition.AttributeType;
                }
                if (  attribute_type == "BOOLEAN" ) {
                    return true;
                }
                if ( attribute_type == "STRING" || attribute_type == "STATE" ) {
                    if ( field.get('fieldDefinition').attributeDefinition.Constrained ) {
                        return true;
                    }
                }
                if ( field.get('name') === 'State' ) { 
                    return true;
                }
                return false;
            } 
        }]);
    },
    
    getSettingsFields: function() {
        var me = this;
        
        return [{
            name: 'typeField',
            xtype: 'rallyfieldcombobox',
            fieldLabel: 'Task Type Field',
            labelWidth: 75,
            labelAlign: 'left',
            minWidth: 200,
            margin: 10,
            autoExpand: false,
            alwaysExpanded: false,
            model: 'Task',
            listeners: {
                ready: function(field_box) {
                    me._filterOutExceptChoices(field_box.getStore());
                }
            },
            readyEvent: 'ready'
        }];
    }
});
