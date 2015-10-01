Ext.define("TSTimeTrackingByActualsChange", {
    extend: 'Rally.app.App',
    componentCls: 'app',
    logger: new Rally.technicalservices.Logger(),
    defaults: { margin: 10 },
    items: [
        {xtype:'container',itemId:'selector_box', layout: { type: 'hbox' }},
        {xtype:'container',itemId:'display_box'}
    ],
    
    start_date: null,
    end_date  : null,
    
    config: {
        defaultSettings: {
            typeField: 'State',
            productField: 'Expedite'
        }
    },
    
    launch: function() {
        var me = this;
        this._addSelectors(this.down('#selector_box'));
    },
    
    _addSelectors: function(container) {
        container.removeAll();
        
        var date_container = container.add({ xtype:'container', layout: { type:'vbox' } });
        
        var spacer = container.add({ xtype: 'container', flex: 1});
        
        var right_container = container.add({xtype:'container'});
        
        date_container.add({
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
        
        date_container.add({
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

        right_container.add({
            xtype:'rallybutton',
            itemId:'export_button',
            text: '<span class="icon-export"> </span>',
            disabled: true
        });
    },
    
    _updateData: function() {
        var me = this;
        this.logger.log('updateData');

        if ( this._hasNeededDates() ) {
            this.down('#display_box').removeAll();

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
                failure: function(msg) {
                    Ext.Msg.alert("Problem loading Actuals", msg);
                },
                
                success: function(snaps) {
                    this.down('#display_box').removeAll();
                    
                    if ( snaps.length === 0 ) {
                        this.down('#display_box').add({
                            xtype:'container',
                            html :'No changes found'
                        });
                        return;
                    }
                    var rows = this._getTasksFromSnaps(snaps);
                    this.logger.log("Number of tasks:", rows.length);
                    
                    this.setLoading("Gathering Related Information");
                    
                    Deft.Chain.sequence([
                        function() { return this._getStoriesByOID(rows); },
                        function() { return this._getOwnersByOID(rows); }
                    ],this).then({
                        scope: this,
                        success: function(results) {
                            var stories_by_oid = results[0];
                            var users_by_oid   = results[1];
                            
                            this._updateEpicInformation(rows,stories_by_oid);
                            this._updateOwnerInformation(rows,users_by_oid);
                            
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
                {property:'_TypeHierarchy', value:'Task'},
                {property: '_ValidFrom',operator: '>=', value: start_date},
                {property: '_ValidFrom',operator: '<=', value: end_date},
                {property:'Actuals',operator:'>',value: 0},
                {property:'_ProjectHierarchy', operator:'in', value: [this.getContext().getProject().ObjectID]},
                {property: '_PreviousValues.Actuals', operator: 'exists', value: true}
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
        },this);
        
        return Ext.Object.getValues(row_hash);
    },
    
    _getStoriesByOID: function(rows) {
        var deferred = Ext.create('Deft.Deferred');
        var me = this;
        var workproducts = Ext.Array.pluck(rows,'WorkProduct');
        var unique_workproducts = Ext.Array.unique(workproducts);
                
        var filter_array = Ext.Array.map(unique_workproducts, function(wp) {
            return { property: 'ObjectID', value: wp };
        });
        
        this.logger.log("# of stories to fetch:", unique_workproducts.length);
        
        var chunk_size = 100;
        var array_of_filters = [];
        while (filter_array.length > 0) {
            array_of_filters.push(filter_array.splice(0, chunk_size));
        }
            
        var promises = [];
        Ext.Array.each(array_of_filters,function(filters) {
            promises.push( function() {
                var config = {
                    filters: Rally.data.wsapi.Filter.or(filters),
                    model  : 'HierarchicalRequirement',
                    limit  : Infinity,
                    fetch  : ['FormattedID','Name','Feature','Parent',me.getSetting('productField')]
                };
                return me._loadWSAPIItems(config);
            });
        });
        
        
        Deft.Chain.sequence(promises,this).then({
            success: function(stories) {
                var stories_by_oid = {};
                Ext.Array.each(Ext.Array.flatten(stories), function(story){
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
    
    _getOwnersByOID: function(rows) {
        var deferred = Ext.create('Deft.Deferred');
        var me = this;
        var owners = Ext.Array.pluck(rows,'Owner');
        var unique_owners = Ext.Array.unique(owners);
        this.logger.log("# of owners to fetch:", unique_owners.length);

        var filter_array = Ext.Array.map(unique_owners, function(owner) {
            return { property: 'ObjectID', value: owner };
        });
        
        var chunk_size = 100;
        var array_of_filters = [];
        while (filter_array.length > 0) {
            array_of_filters.push(filter_array.splice(0, chunk_size));
        }
            
        var promises = [];
        Ext.Array.each(array_of_filters,function(filters) {
            promises.push( function() {
                var config = {
                    filters: Rally.data.wsapi.Filter.or(filters),
                    model  : 'User',
                    limit  : Infinity,
                    fetch  : ['UserName','CostCenter','OfficeLocation','Department','Role']
                };
                return me._loadWSAPIItems(config);
            });
        });
        
        
        Deft.Chain.sequence(promises,this).then({
            success: function(users) {
                var users_by_oid = {};
                Ext.Array.each(Ext.Array.flatten(users), function(user){
                    users_by_oid[user.get('ObjectID')] = user;
                });
                deferred.resolve(users_by_oid);
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
            
            if (story && story.get('Feature') && story.get('Feature').Parent) {
                row['__epic'] = story.get('Feature').Parent;
                
                row['__epic_product'] = story.get('Feature').Parent[this.getSetting('productField')] || '--';
            } else {
                row['__epic'] = {};
                row['__epic_product'] = '--';
            }
        },this);
    },
    
    _updateOwnerInformation: function(rows,users_by_oid) {
        Ext.Array.each(rows, function(row){
            var owner_oid = row.Owner;
            var owner = users_by_oid[owner_oid];

            row['__owner'] = owner;
                        
            if (owner) {
                row['__owner_cost_center'] = owner.get('CostCenter');
                row['__owner_role'] = owner.get('Role');
                row['__owner_department'] = owner.get('Department');
                row['__owner_location'] = owner.get('OfficeLocation');
            } else {
                row['__owner_cost_center'] = '';
                row['__owner_department'] = '';
                row['__owner_location'] = '';
                row['__owner_role'] = '';
            }

        },this);
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
        
        this.logger.log(config.model, "Loading with filters: ", Ext.clone(config.filters));
        
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
                {dataIndex:'FormattedID', text:'Task Number', renderer: function(value, meta, record) {
                    var url = Rally.nav.Manager.getDetailUrl( '/task/' + record.get('ObjectID') );
                    return Ext.String.format("<a href={0} target='_blank'>{1}</a>", url, value);
                }},
                {dataIndex: this.getSetting('typeField'), text: 'Task Type' },
                {dataIndex:'__owner', text:'Owner', renderer: function(v) {
                    if ( Ext.isEmpty(v) ) {
                        return "--";
                    }
                    return v.get('_refObjectName');
                }},
                {dataIndex:'__owner_cost_center', text:'Cost Center' },
                {dataIndex:'__owner_department', text:'Department' },
                {dataIndex:'__owner_location', text:'Office Location' },
                {dataIndex:'__owner_role', text:'Role' },

                {dataIndex:'__delta', text:'Actual Time'},
                {dataIndex:'__epic', text: 'Epic', renderer: function(v) {
                    if ( !v.FormattedID ) {
                        return "--";
                    } 
                    
                    return v.FormattedID;
                } },
                {dataIndex: '__epic_product', text:'Product' }
            ],
            listeners: {
                scope: this,
                viewready: function() {
                    this.down('#export_button') && this.down('#export_button').setDisabled(false);
                },
                destroy: function() {
                    this.down('#export_button') && this.down('#export_button').setDisabled(true);
                }
            }
        });
    },
    
    _export: function(){
        var grid = this.down('rallygrid');
        
        if ( !grid ) { return; }
        
        this.logger.log('_export',grid);

        var filename = Ext.String.format('task-report.csv');

        var csv = Rally.technicalservices.FileUtilities.getCSVFromGrid(this,grid).then({
            scope: this,
            success: function(csv){
                if (csv && csv.length > 0){
                    Rally.technicalservices.FileUtilities.saveCSVToFile(csv,filename);
                } else {
                    Rally.ui.notify.Notifier.showWarning({message: 'No data to export'});
                }
                
            }
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
                app.logger.log('field:', field.get('name'), field);
                
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
        },
        {
            name: 'productField',
            xtype: 'rallyfieldcombobox',
            fieldLabel: 'Product Field',
            labelWidth: 75,
            labelAlign: 'left',
            minWidth: 200,
            margin: 10,
            autoExpand: false,
            alwaysExpanded: false,
            model: 'PortfolioItem',
            listeners: {
                ready: function(field_box) {
                    me._filterOutExceptChoices(field_box.getStore());
                }
            },
            readyEvent: 'ready'
        }];
    }
});
